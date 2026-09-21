import type { Curve } from "./curves.js";
import { MigrationError } from "./errors.js";
import { mulDivFloor } from "./exact.js";
import { MigrationStrategy, type MigrationResult } from "./types.js";

/**
 * Converting existing totals when the curve changes.
 *
 * A curve change moves the level of every member in the community. That is one
 * of the most disruptive things an operator can do, and it is the reason a
 * curve change is always a major version. This module makes it survivable: it
 * rewrites the stored totals so that nobody wakes up two levels lower than
 * they went to bed.
 */

/** Convert one total from one curve to another. */
export function migrateTotalXp(
  totalXp: number,
  from: Curve,
  to: Curve,
  strategy: MigrationStrategy = MigrationStrategy.PreserveProgress,
): MigrationResult {
  const before = from.progressForTotalXp(totalXp);

  if (strategy === MigrationStrategy.PreserveXp) {
    const after = to.progressForTotalXp(totalXp);
    return build(strategy, before, after, false);
  }

  const targetLevel = Math.min(before.level, to.maxLevel);
  // The new curve does not go as high as the member already stands.
  const clampedToCurveTop = targetLevel < before.level;
  const base = to.totalXpForLevel(targetLevel);

  if (strategy === MigrationStrategy.PreserveLevel) {
    const after = to.progressForTotalXp(base);
    return build(strategy, before, after, clampedToCurveTop);
  }

  if (strategy === MigrationStrategy.PreserveProgress) {
    let newTotal = base;
    if (targetLevel < to.maxLevel) {
      const nextThreshold = to.totalXpForLevel(targetLevel + 1);
      const span = nextThreshold - base;
      // Floor, so a member can never be pushed *into* the next level by the
      // migration itself — a free level is as confusing as a lost one.
      newTotal = base + mulDivFloor(span, before.progressPermille, 1000);
      // Flooring is not enough on its own. A member sitting at the top of the
      // old curve reports a full bar — 1000 permille, by convention, because
      // there is no next level to be part-way to — and carrying a full bar into
      // a curve that *does* have a next level lands them exactly on its
      // threshold. Until 2.0.0 that gave every maxed member a free level the
      // moment an operator extended their curve, which is one of the most
      // ordinary changes there is.
      if (newTotal >= nextThreshold) {
        newTotal = nextThreshold - 1;
      }
    }
    const after = to.progressForTotalXp(newTotal);
    return build(strategy, before, after, clampedToCurveTop);
  }

  throw new MigrationError("Unknown migration strategy", { strategy });
}

/**
 * Convert a whole scope at once.
 *
 * Returns one result per input in the same order, so the caller can write the
 * new totals back with a single bulk update.
 */
export function migrateAll(
  totals: readonly number[],
  from: Curve,
  to: Curve,
  strategy: MigrationStrategy = MigrationStrategy.PreserveProgress,
): MigrationResult[] {
  return totals.map((total) => migrateTotalXp(total, from, to, strategy));
}

/** What a migration would do to a scope, without changing anything. */
export interface MigrationReport {
  readonly strategy: MigrationStrategy;
  readonly memberCount: number;
  /** Members whose level number stays the same. */
  readonly unchanged: number;
  readonly gainedLevels: number;
  readonly lostLevels: number;
  /** Largest number of levels any single member gains. */
  readonly maxGain: number;
  /** Largest number of levels any single member loses. */
  readonly maxLoss: number;
  /** Sum of all totals before and after — useful as a sanity check. */
  readonly totalXpBefore: number;
  readonly totalXpAfter: number;
  /** True when no member loses a level. The number an operator asks for. */
  readonly safeForMembers: boolean;
}

/**
 * Preview a curve change.
 *
 * Run this before switching, put the numbers in front of whoever owns the
 * community, and let them decide. The concept is explicit that this step is
 * not optional: a curve change without a preview produces complaints.
 */
export function previewMigration(
  totals: readonly number[],
  from: Curve,
  to: Curve,
  strategy: MigrationStrategy = MigrationStrategy.PreserveProgress,
): MigrationReport {
  const results = migrateAll(totals, from, to, strategy);

  let unchanged = 0;
  let gainedLevels = 0;
  let lostLevels = 0;
  let maxGain = 0;
  let maxLoss = 0;
  let totalXpBefore = 0;
  let totalXpAfter = 0;

  for (const result of results) {
    totalXpBefore += result.previousTotalXp;
    totalXpAfter += result.newTotalXp;
    if (result.levelDelta === 0) {
      unchanged += 1;
    } else if (result.levelDelta > 0) {
      gainedLevels += 1;
      if (result.levelDelta > maxGain) {
        maxGain = result.levelDelta;
      }
    } else {
      lostLevels += 1;
      if (-result.levelDelta > maxLoss) {
        maxLoss = -result.levelDelta;
      }
    }
  }

  return {
    strategy,
    memberCount: results.length,
    unchanged,
    gainedLevels,
    lostLevels,
    maxGain,
    maxLoss,
    totalXpBefore,
    totalXpAfter,
    safeForMembers: lostLevels === 0,
  };
}

function build(
  strategy: MigrationStrategy,
  before: { level: number; totalXp: number; progressPermille: number },
  after: { level: number; totalXp: number; progressPermille: number },
  clampedToCurveTop: boolean,
): MigrationResult {
  return {
    strategy,
    previousTotalXp: before.totalXp,
    newTotalXp: after.totalXp,
    previousLevel: before.level,
    newLevel: after.level,
    levelDelta: after.level - before.level,
    previousProgressPermille: before.progressPermille,
    newProgressPermille: after.progressPermille,
    clampedToCurveTop,
  };
}
