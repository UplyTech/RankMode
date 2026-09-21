/**
 * The invariants, stated as invariants rather than as three examples each.
 *
 * The rest of the suite pins down specific numbers, which is the right way to
 * test a formula. It is the wrong way to test a *rule*: "a sequence of awards
 * never exceeds the period cap" is true of every sequence, and three examples
 * of it prove three sequences.
 *
 * These mirror `python/tests/test_properties.py` property for property. The
 * Python side's run of these found the free-level bug in `PRESERVE_PROGRESS`
 * that 473 example-based tests had not.
 *
 * fast-check is a development dependency only; the promise of zero runtime
 * dependencies is unaffected, and CI checks it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyMultipliers,
  buildLeaderboard,
  type Curve,
  createEventRule,
  createMemberState,
  ExponentialCurve,
  FixedRandomSource,
  LinearCurve,
  MAX_TOTAL_XP,
  migrateTotalXp,
  MigrationStrategy,
  QuadraticCurve,
  RankEngine,
  rankOf,
  serializeMemberState,
  TabularCurve,
  TieMode,
  type LeaderboardInput,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Bases that reach past 2^53 in an intermediate product as well as ordinary ones. */
const base = fc.constantFrom(1, 7, 25, 100, 999, 1_000_000, 1_000_000_003, 9_007_199_254_740);
const total = fc.integer({ min: 0, max: MAX_TOTAL_XP });
const maxLevel = fc.integer({ min: 1, max: 200 });

const generatedCurve: fc.Arbitrary<Curve> = fc.oneof(
  fc.record({ base, maxLevel }).map((options) => new LinearCurve(options) as Curve),
  fc.record({ base, maxLevel }).map((options) => new QuadraticCurve(options) as Curve),
  fc
    .record({
      base,
      maxLevel,
      growthPermille: fc.constantFrom(1001, 1100, 1500, 2000, 3000),
    })
    .map((options) => new ExponentialCurve(options) as Curve),
);

const tabularCurve: fc.Arbitrary<Curve> = fc
  .array(fc.integer({ min: 1, max: 10 ** 12 }), { minLength: 1, maxLength: 15 })
  .map((steps) => {
    const thresholds = [0];
    for (const step of steps) {
      thresholds.push((thresholds[thresholds.length - 1] as number) + step);
    }
    return new TabularCurve(thresholds) as Curve;
  });

const anyCurve = fc.oneof(generatedCurve, tabularCurve);

// ---------------------------------------------------------------------------
describe("properties: curves", () => {
  it("builds thresholds that ascend strictly from zero", () => {
    fc.assert(
      fc.property(anyCurve, (curve) => {
        expect(curve.thresholds[0]).toBe(0);
        for (let level = 1; level <= curve.maxLevel; level += 1) {
          expect(curve.thresholds[level] as number).toBeGreaterThan(
            curve.thresholds[level - 1] as number,
          );
        }
      }),
    );
  });

  it("round-trips a level through its own threshold", () => {
    fc.assert(
      fc.property(anyCurve, fc.nat(), (curve, seed) => {
        const level = seed % (curve.maxLevel + 1);
        expect(curve.levelForTotalXp(curve.totalXpForLevel(level))).toBe(level);
      }),
    );
  });

  it("places every total inside the level it reports", () => {
    fc.assert(
      fc.property(anyCurve, total, (curve, totalXp) => {
        const level = curve.levelForTotalXp(totalXp);
        expect(curve.thresholds[level] as number).toBeLessThanOrEqual(totalXp);
        if (level < curve.maxLevel) {
          expect(totalXp).toBeLessThan(curve.thresholds[level + 1] as number);
        }
      }),
    );
  });

  it("reports progress that is internally consistent", () => {
    fc.assert(
      fc.property(anyCurve, total, (curve, totalXp) => {
        const progress = curve.progressForTotalXp(totalXp);
        expect(progress.progressPermille).toBeGreaterThanOrEqual(0);
        expect(progress.progressPermille).toBeLessThanOrEqual(1000);
        expect(progress.currentThreshold + progress.xpIntoLevel).toBe(totalXp);
        if (progress.nextThreshold === null) {
          expect(progress.isMaxLevel).toBe(true);
          expect(progress.progressPermille).toBe(1000);
        } else {
          expect(totalXp + (progress.xpToNext as number)).toBe(progress.nextThreshold);
          expect(progress.levelSpan).toBe(progress.nextThreshold - progress.currentThreshold);
        }
      }),
    );
  });
});

describe("properties: multipliers", () => {
  it("matches step-by-step floor division", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 9 }),
        fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 6 }),
        (baseXp, permilles) => {
          let expected = BigInt(baseXp);
          for (const permille of permilles) {
            expected = (expected * BigInt(permille)) / 1000n;
          }
          const chain = permilles.map((permille, index) => ({
            source: `s${index}`,
            permille,
          }));
          expect(applyMultipliers(baseXp, chain)).toBe(Number(expected));
        },
      ),
    );
  });

  it("never increases a value with a factor at or below 1.0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 9 }),
        fc.integer({ min: 0, max: 1000 }),
        (baseXp, permille) => {
          expect(
            applyMultipliers(baseXp, [{ source: "r", permille }]),
          ).toBeLessThanOrEqual(baseXp);
        },
      ),
    );
  });
});

describe("properties: awards", () => {
  it("never lets a sequence exceed the period cap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 6 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 500 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 30 }),
        (initial, minXp, extra, cap, rolls, stepCount) => {
          const engine = new RankEngine({
            curve: new QuadraticCurve({ base: 100, maxLevel: 100 }),
            rules: [
              createEventRule({
                eventType: "message",
                minXp,
                maxXp: minXp + extra,
                cooldownSeconds: 0,
                periodCapXp: cap,
                periodSeconds: 86400,
              }),
            ],
          });
          const random = new FixedRandomSource(rolls, { cycle: true });
          let state = createMemberState(initial);
          const now = 1_700_000_000_000;

          let awarded = 0;
          for (let step = 0; step < stepCount; step += 1) {
            // Every step inside one period, so the cap cannot reset.
            const result = engine.award(state, "message", {
              now: now + step * 1000,
              random,
            });
            awarded += result.awardedXp;
            state = result.state;
          }

          expect(awarded).toBeLessThanOrEqual(cap);
          expect(state.totalXp).toBe(initial + awarded);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("always reports a signed delta that matches the totals", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 9 }),
        fc.integer({ min: 0, max: 10 ** 9 }),
        (initial, amount) => {
          const engine = new RankEngine({
            curve: new QuadraticCurve({ base: 100, maxLevel: 200 }),
          });
          const result = engine.penalize(createMemberState(initial), amount, { now: 1 });
          expect(result.newTotalXp - result.previousTotalXp).toBe(result.awardedXp);
          expect(result.changed).toBe(result.awardedXp !== 0);
          expect(result.newTotalXp).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it("never mutates the state it was handed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 6 }),
        fc.integer({ min: 0, max: 1000 }),
        (initial, baseXp) => {
          const engine = new RankEngine({
            curve: new QuadraticCurve({ base: 100, maxLevel: 100 }),
            rules: [
              createEventRule({
                eventType: "message",
                minXp: 10,
                maxXp: 20,
                cooldownSeconds: 60,
              }),
            ],
          });
          const state = createMemberState(initial);
          const before = JSON.stringify(serializeMemberState(state));
          engine.award(state, "message", { now: 1, baseXp });
          expect(JSON.stringify(serializeMemberState(state))).toBe(before);
        },
      ),
    );
  });
});

describe("properties: leaderboards", () => {
  const rows = fc.array(
    fc.record({
      memberId: fc.string({ minLength: 1, maxLength: 8 }),
      totalXp: total,
    }),
    { maxLength: 40 },
  );
  const tieModes = fc.constantFrom(TieMode.Competition, TieMode.Dense, TieMode.Ordinal);

  it("returns a permutation of its input", () => {
    fc.assert(
      fc.property(rows, tieModes, (input: LeaderboardInput[], tieMode) => {
        const curve = new QuadraticCurve({ base: 100, maxLevel: 200 });
        const board = buildLeaderboard(curve, input, { tieMode });
        expect(board).toHaveLength(input.length);
        expect(board.map((entry) => entry.totalXp).sort((a, b) => a - b)).toEqual(
          input.map((row) => row.totalXp).sort((a, b) => a - b),
        );
      }),
    );
  });

  it("never increases a total, or decreases a rank, going down the board", () => {
    fc.assert(
      fc.property(rows, tieModes, (input: LeaderboardInput[], tieMode) => {
        const curve = new QuadraticCurve({ base: 100, maxLevel: 200 });
        const board = buildLeaderboard(curve, input, { tieMode });
        for (let index = 1; index < board.length; index += 1) {
          const previous = board[index - 1]!;
          const entry = board[index]!;
          expect(entry.totalXp).toBeLessThanOrEqual(previous.totalXp);
          expect(entry.rank).toBeGreaterThanOrEqual(previous.rank);
        }
      }),
    );
  });

  it("agrees with rankOf for every member on the board", () => {
    fc.assert(
      fc.property(rows, tieModes, (input: LeaderboardInput[], tieMode) => {
        // Duplicate ids make "the" rank ambiguous: buildLeaderboard keeps both
        // rows while rankOf finds the first.
        fc.pre(new Set(input.map((row) => row.memberId)).size === input.length);
        const curve = new QuadraticCurve({ base: 100, maxLevel: 200 });
        for (const entry of buildLeaderboard(curve, input, { tieMode })) {
          expect(rankOf(entry.memberId, input, { tieMode })).toBe(entry.rank);
        }
      }),
    );
  });
});

describe("properties: migration", () => {
  it("never moves a member's level, except off the top of a shorter curve", () => {
    fc.assert(
      fc.property(
        anyCurve,
        anyCurve,
        fc.integer({ min: 0, max: 10 ** 7 }),
        (from, to, totalXp) => {
          for (const strategy of [
            MigrationStrategy.PreserveLevel,
            MigrationStrategy.PreserveProgress,
          ]) {
            const result = migrateTotalXp(totalXp, from, to, strategy);
            if (result.clampedToCurveTop) {
              expect(result.newLevel).toBe(to.maxLevel);
            } else {
              expect(result.levelDelta).toBe(0);
            }
          }
        },
      ),
    );
  });

  it("never hands out a free level", () => {
    // The property that found the bug: a member at the top of the old curve
    // reports a full bar, and carrying a full bar into a longer curve landed
    // them exactly on the next threshold.
    fc.assert(
      fc.property(
        anyCurve,
        anyCurve,
        fc.integer({ min: 0, max: 10 ** 7 }),
        (from, to, totalXp) => {
          const result = migrateTotalXp(
            totalXp,
            from,
            to,
            MigrationStrategy.PreserveProgress,
          );
          expect(result.levelDelta).toBeLessThanOrEqual(0);
        },
      ),
    );
  });

  it("is a no-op onto the same curve", () => {
    fc.assert(
      fc.property(anyCurve, fc.integer({ min: 0, max: 10 ** 7 }), (curve, totalXp) => {
        const result = migrateTotalXp(totalXp, curve, curve, MigrationStrategy.PreserveXp);
        expect(result.newTotalXp).toBe(totalXp);
        expect(result.levelDelta).toBe(0);
      }),
    );
  });
});
