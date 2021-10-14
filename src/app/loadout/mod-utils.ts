import { UpgradeSpendTier } from '@destinyitemmanager/dim-api-types';
import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { DimItem, PluggableInventoryItemDefinition } from 'app/inventory/item-types';
import { isPluggableItem } from 'app/inventory/store/sockets';
import { getItemEnergyType, isModEnergyValid } from 'app/loadout-builder/mod-assignments';
import { generateModPermutations } from 'app/loadout-builder/mod-permutations';
import { activityModPlugCategoryHashes, bucketsToCategories } from 'app/loadout-builder/types';
import { upgradeSpendTierToMaxEnergy } from 'app/loadout-builder/utils';
import { armor2PlugCategoryHashesByName } from 'app/search/d2-known-values';
import {
  combatCompatiblePlugCategoryHashes,
  ModSocketMetadata,
} from 'app/search/specialty-modslots';
import { chainComparator, compareBy } from 'app/utils/comparators';
import {
  getModTypeTagByPlugCategoryHash,
  getSpecialtySocketMetadatas,
  isArmor2Mod,
} from 'app/utils/item-utils';
import { DestinyEnergyType, DestinyInventoryItemDefinition } from 'bungie-api-ts/destiny2';
import _ from 'lodash';
import { knownModPlugCategoryHashes } from './known-values';

/**
 * Sorts PluggableInventoryItemDefinition's by the following list of comparators.
 * 1. The known plug category hashes, see ./types#knownModPlugCategoryHashes for ordering
 * 2. itemTypeDisplayName, so that legacy and combat mods are ordered alphabetically by their category name
 * 3. energyType, so mods in each category go Any, Arc, Solar, Void
 * 4. by energy cost, so cheaper mods come before more expensive mods
 * 5. by mod name, so mods in the same category with the same energy type and cost are alphabetical
 */
export const sortMods = chainComparator<PluggableInventoryItemDefinition>(
  compareBy((mod) => {
    const knownIndex = knownModPlugCategoryHashes.indexOf(mod.plug.plugCategoryHash);
    return knownIndex === -1 ? knownModPlugCategoryHashes.length : knownIndex;
  }),
  compareBy((mod) => mod.itemTypeDisplayName),
  compareBy((mod) => mod.plug.energyCost?.energyType),
  compareBy((mod) => mod.plug.energyCost?.energyCost),
  compareBy((mod) => mod.displayProperties.name)
);

/** Sorts an array of PluggableInventoryItemDefinition[]'s by the order of hashes in
 * loadout/know-values#knownModPlugCategoryHashes and then sorts those not found in there by name.
 *
 * This assumes that each PluggableInventoryItemDefinition in each PluggableInventoryItemDefinition[]
 * has the same plugCategoryHash as it pulls it from the first PluggableInventoryItemDefinition.
 */
export const sortModGroups = chainComparator(
  compareBy((mods: PluggableInventoryItemDefinition[]) => {
    // We sort by known knownModPlugCategoryHashes so that it general, helmet, ..., classitem, raid, others.
    const knownIndex = knownModPlugCategoryHashes.indexOf(mods[0].plug.plugCategoryHash);
    return knownIndex === -1 ? knownModPlugCategoryHashes.length : knownIndex;
  }),
  compareBy((mods: PluggableInventoryItemDefinition[]) => mods[0].itemTypeDisplayName)
);

/** Figures out if a definition is an insertable armor 2.0 mod. To do so it does the following
 * 1. Figures out if the def is pluggable (def.plug exists)
 * 2. Checks to see if the plugCategoryHash is in one of our known plugCategoryHashes (relies on d2ai).
 * 3. Checks to see if plug.insertionMaterialRequirementHash is non zero or plug.energyCost a thing. This rules out deprecated mods.
 * 4. Makes sure that itemTypeDisplayName is a thing, this rules out classified items.
 */
export function isInsertableArmor2Mod(
  def: DestinyInventoryItemDefinition
): def is PluggableInventoryItemDefinition {
  return Boolean(
    isPluggableItem(def) &&
      isArmor2Mod(def) &&
      (def.plug.insertionMaterialRequirementHash !== 0 || def.plug.energyCost) &&
      def.itemTypeDisplayName !== undefined
  );
}

/**
 * Generates a unique key for a mod when rendering. As mods can appear multiple times as
 * siblings we need to count them and append a number to its hash to make it unique.
 *
 * Note that counts is mutated and a new object should be passed in with each render.
 */
export const getModRenderKey = (
  mod: PluggableInventoryItemDefinition,
  /** A supplied object to store the counts in. This is mutated. */
  counts: Record<number, number>
) => {
  if (!counts[mod.hash]) {
    counts[mod.hash] = 0;
  }

  return `${mod.hash}-${counts[mod.hash]++}`;
};

interface ModAssignments {
  assigned: PluggableInventoryItemDefinition[];
  unassigned: PluggableInventoryItemDefinition[];
}

/**
 * This finds the cheapest possible mod assignments for an armour set and a set of mods.
 *
 * It uses the idea of total energy spent and wasted to rank mod assignments.
 *
 * To do this we create permutations of general, combat and activity mods and loop over each
 * set of permutations and validate the possibility of the mod assignment at every level.
 * This is to ensure that we can exit early if a invalid assignment is found.
 */
export function getCheapestModAssignments(
  items: DimItem[],
  mods: PluggableInventoryItemDefinition[],
  defs: D2ManifestDefinitions | undefined,
  upgradeSpendTier: UpgradeSpendTier,
  lockItemEnergyType: boolean
): [Map<string, PluggableInventoryItemDefinition[]>, PluggableInventoryItemDefinition[]] {
  if (!defs) {
    return [new Map(), []];
  }

  let bucketIndependentAssignments = new Map<string, ModAssignments>();
  const bucketSpecificAssignments = new Map<string, ModAssignments>();

  // just an arbitrarily large number
  let assignmentEnergyCost = 10000;
  let assignmentUnassignedModCount = 10000;

  for (const item of items) {
    bucketSpecificAssignments.set(item.id, { assigned: [], unassigned: [] });
    bucketIndependentAssignments.set(item.id, { assigned: [], unassigned: [] });
  }

  // An object of item id's to specialty socket metadata, this is used to ensure that
  // combat and activity mods can be slotted into an item.
  const itemSocketMetadata = _.mapValues(
    _.keyBy(items, (item) => item.id),
    (item) => getSpecialtySocketMetadatas(item)
  );

  const generalMods: PluggableInventoryItemDefinition[] = [];
  const combatMods: PluggableInventoryItemDefinition[] = [];
  const activityMods: PluggableInventoryItemDefinition[] = [];

  // Divide up the locked mods into general, combat and activity mod arrays. Also we
  // take the bucket specific mods and put them in a map of item id's to mods so
  // we can calculate the used energy values for each item
  for (const mod of mods) {
    if (mod.plug.plugCategoryHash === armor2PlugCategoryHashesByName.general) {
      generalMods.push(mod);
    } else if (combatCompatiblePlugCategoryHashes.includes(mod.plug.plugCategoryHash)) {
      combatMods.push(mod);
    } else if (activityModPlugCategoryHashes.includes(mod.plug.plugCategoryHash)) {
      activityMods.push(mod);
    } else {
      const itemForMod = items.find(
        (item) => mod.plug.plugCategoryHash === bucketsToCategories[item.bucket.hash]
      );

      if (
        itemForMod &&
        isBucketSpecificModValid(
          defs,
          upgradeSpendTier,
          lockItemEnergyType,
          itemForMod,
          mod,
          bucketSpecificAssignments.get(itemForMod.id)?.assigned || []
        )
      ) {
        bucketSpecificAssignments.get(itemForMod.id)?.assigned.push(mod);
      } else if (itemForMod) {
        bucketSpecificAssignments.get(itemForMod.id)?.unassigned.push(mod);
      }
    }
  }

  // A object of item id's to energy information. This is so we can precalculate
  // working energy used, capacity and type and use this to validate whether a mod
  // can be used in an item.
  const itemEnergies = _.mapValues(
    _.keyBy(items, (item) => item.id),
    (item) =>
      buildItemEnergy(
        defs,
        item,
        bucketSpecificAssignments.get(item.id)?.assigned || [],
        upgradeSpendTier,
        lockItemEnergyType
      )
  );

  const generalModPermutations = generateModPermutations(generalMods);
  const combatModPermutations = generateModPermutations(combatMods);
  const activityModPermutations = generateModPermutations(activityMods);

  for (const activityPermutation of activityModPermutations) {
    for (const combatPermutation of combatModPermutations) {
      modLoop: for (const generalPermutation of generalModPermutations) {
        let unassignedModCount = 0;
        const assignments: Map<string, ModAssignments> = new Map();

        for (let i = 0; i < items.length; i++) {
          const assigned = [];
          const unassigned = [];
          const item = items[i];

          const activityMod = activityPermutation[i];
          if (
            activityMod &&
            isActivityModValid(activityMod, itemSocketMetadata[item.id], itemEnergies[item.id])
          ) {
            assigned.push(activityMod);
          } else if (activityMod) {
            unassigned.push(activityMod);
          }

          const combatMod = combatPermutation[i];
          if (
            combatMod &&
            isCombatModValid(
              combatMod,
              assigned,
              itemSocketMetadata[item.id],
              itemEnergies[item.id]
            )
          ) {
            assigned.push(combatMod);
          } else if (combatMod) {
            unassigned.push(combatMod);
          }

          const generalMod = generalPermutation[i];
          if (generalMod && isModEnergyValid(itemEnergies[item.id], generalMod, ...assigned)) {
            assigned.push(generalMod);
          } else if (generalMod) {
            unassigned.push(generalMod);
          }

          if (unassignedModCount + unassigned.length > assignmentUnassignedModCount) {
            continue modLoop;
          }

          unassignedModCount += unassigned.length;
          assignments.set(item.id, { assigned, unassigned });
        }

        // This is after the item loop
        let energyUsedAndWasted = 0;
        for (const [itemId, { assigned }] of assignments) {
          energyUsedAndWasted += calculateEnergyChange(itemEnergies[itemId], assigned);
        }

        // if the cost of the new assignment set is better than the old one
        // we replace it and carry on until we have exhausted all permutations.
        if (
          unassignedModCount < assignmentUnassignedModCount ||
          (unassignedModCount <= assignmentUnassignedModCount &&
            energyUsedAndWasted < assignmentEnergyCost)
        ) {
          bucketIndependentAssignments = assignments;
          assignmentEnergyCost = energyUsedAndWasted;
          assignmentUnassignedModCount = unassignedModCount;
        }
      }
    }
  }

  const mergedResults = new Map<string, PluggableInventoryItemDefinition[]>();
  let unassigned: PluggableInventoryItemDefinition[] = [];
  for (const item of items) {
    mergedResults.set(item.id, [
      ...(bucketIndependentAssignments.get(item.id)?.assigned || []),
      ...(bucketSpecificAssignments.get(item.id)?.assigned || []),
    ]);
    unassigned = [
      ...unassigned,
      ...(bucketIndependentAssignments.get(item.id)?.unassigned || []),
      ...(bucketSpecificAssignments.get(item.id)?.unassigned || []),
    ];
  }

  return [mergedResults, unassigned];
}

interface ItemEnergy {
  used: number;
  originalCapacity: number;
  derivedCapacity: number;
  originalType: DestinyEnergyType;
  derivedType: DestinyEnergyType;
}

function buildItemEnergy(
  defs: D2ManifestDefinitions,
  item: DimItem,
  assignedMods: PluggableInventoryItemDefinition[],
  upgradeSpendTier: UpgradeSpendTier,
  lockItemEnergyType: boolean
): ItemEnergy {
  return {
    used: _.sumBy(assignedMods, (mod) => mod.plug.energyCost?.energyCost || 0),
    originalCapacity: item.energy?.energyCapacity || 0,
    derivedCapacity: upgradeSpendTierToMaxEnergy(defs, upgradeSpendTier, item),
    originalType: item.energy?.energyType || DestinyEnergyType.Any,
    derivedType: getItemEnergyType(defs, item, upgradeSpendTier, lockItemEnergyType, assignedMods),
  };
}

function isBucketSpecificModValid(
  defs: D2ManifestDefinitions,
  upgradeSpendTier: UpgradeSpendTier,
  lockItemEnergyType: boolean,
  item: DimItem,
  mod: PluggableInventoryItemDefinition,
  assignedMods: PluggableInventoryItemDefinition[]
) {
  const itemEnergyCapacity = upgradeSpendTierToMaxEnergy(defs, upgradeSpendTier, item);
  const itemEnergyType = getItemEnergyType(
    defs,
    item,
    upgradeSpendTier,
    lockItemEnergyType,
    assignedMods
  );
  const energyUsed = _.sumBy(assignedMods, (mod) => mod.plug.energyCost?.energyCost || 0);
  const modCost = mod.plug.energyCost?.energyCost || 0;
  const modEnergyType = mod.plug.energyCost?.energyType || DestinyEnergyType.Any;
  const energyTypeIsValid =
    modEnergyType === itemEnergyType ||
    modEnergyType === DestinyEnergyType.Any ||
    itemEnergyType === DestinyEnergyType.Any;

  return energyTypeIsValid && energyUsed + modCost <= itemEnergyCapacity;
}

function isActivityModValid(
  activityMod: PluggableInventoryItemDefinition,
  itemSocketMetadata: ModSocketMetadata[] | undefined,
  itemEnergy: ItemEnergy
) {
  const modTag = getModTypeTagByPlugCategoryHash(activityMod.plug.plugCategoryHash);

  // The activity mods wont fit in the item set so move on to the next set of mods
  return (
    isModEnergyValid(itemEnergy, activityMod) &&
    modTag &&
    itemSocketMetadata?.some((metadata) => metadata.compatibleModTags.includes(modTag))
  );
}

function isCombatModValid(
  combatMod: PluggableInventoryItemDefinition,
  assignedMods: PluggableInventoryItemDefinition[],
  itemSocketMetadata: ModSocketMetadata[] | undefined,
  itemEnergy: ItemEnergy
) {
  const modTag = getModTypeTagByPlugCategoryHash(combatMod.plug.plugCategoryHash);

  // The activity mods wont fit in the item set so move on to the next set of mods
  return (
    isModEnergyValid(itemEnergy, combatMod, ...assignedMods) &&
    modTag &&
    itemSocketMetadata?.some((metadata) => metadata.compatibleModTags.includes(modTag))
  );
}

function calculateEnergyChange(
  itemEnergy: ItemEnergy,
  assignedMods: PluggableInventoryItemDefinition[]
) {
  let finalEnergy = itemEnergy.derivedType;

  for (const mod of assignedMods) {
    if (finalEnergy !== DestinyEnergyType.Any) {
      break;
    } else if (mod.plug.energyCost?.energyType) {
      finalEnergy = mod.plug.energyCost.energyType;
    }
  }

  const modCost =
    itemEnergy.used + _.sumBy(assignedMods, (mod) => mod.plug.energyCost?.energyCost || 0);
  const energyUsedAndWasted = modCost + itemEnergy.originalCapacity;
  const energyInvested = Math.max(0, modCost - itemEnergy.originalCapacity);

  return finalEnergy === itemEnergy.originalType || finalEnergy === DestinyEnergyType.Any
    ? energyInvested
    : energyUsedAndWasted;
}
