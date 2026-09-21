/**
 * The numbers the rest of the suite never reaches.
 *
 * Every shared vector probes totals up to 1,000,000 and curve bases up to 100.
 * Every other unit test works in the same range. That is why three separate
 * divergences between the two editions survived 473 tests: all of them appear
 * only when an *intermediate* product passes 2^53 - 1, while the inputs and the
 * answer stay comfortably inside it.
 *
 * These tests pin the values the Python edition computes exactly. Python
 * integers do not lose precision, so its answer is the definition of correct,
 * and each expectation below is the number it produces.
 */
import { describe, expect, it } from "vitest";

import {
  applyMultipliers,
  combinedPermille,
  ConfigurationError,
  createCurve,
  createMemberState,
  ExponentialCurve,
  LinearCurve,
  MAX_TOTAL_XP,
  migrateTotalXp,
  MigrationStrategy,
  QuadraticCurve,
  RankEngine,
  TabularCurve,
  XpOverflowError,
} from "../src/index.js";

describe("magnitudes: exponential curves", () => {
  // Each of these four specifications built a *different threshold table* in
  // the two editions until 2.0.0, because `cost * growthPermille` passed 2^53.
  it.each([
    { base: 1_000_000_003, growthPermille: 1500, level: 30, expected: 383500119396580 },
    { base: 999, growthPermille: 3000, level: 24, expected: 141073553471760 },
    { base: 1_000_000_003, growthPermille: 3000, level: 15, expected: 7174453021523359 },
    { base: 9_007_199_254_740, growthPermille: 1500, level: 8, expected: 443674932040112 },
  ])(
    "agrees with the Python edition at base $base, growth $growthPermille",
    ({ base, growthPermille, level, expected }) => {
      const curve = new ExponentialCurve({ base, growthPermille, maxLevel: 500 });
      expect(curve.thresholds[level]).toBe(expected);
    },
  );

  it("keeps every threshold a safe integer and strictly ascending", () => {
    const curve = new ExponentialCurve({
      base: 9_007_199_254_740,
      growthPermille: 1500,
      maxLevel: 500,
    });
    for (let level = 1; level <= curve.maxLevel; level += 1) {
      const threshold = curve.thresholds[level] as number;
      expect(Number.isSafeInteger(threshold)).toBe(true);
      expect(threshold).toBeGreaterThan(curve.thresholds[level - 1] as number);
      expect(threshold).toBeLessThanOrEqual(MAX_TOTAL_XP);
    }
  });
});

describe("magnitudes: generated curves with a large base", () => {
  it("stops the linear table before a threshold could be rounded", () => {
    // `base * level` alone passes 2^53 here, before any ceiling check sees it.
    const curve = new LinearCurve({ base: 9_007_199_254_740, maxLevel: 1000 });
    expect(curve.maxLevel).toBe(1000);
    expect(curve.thresholds.every((value) => Number.isSafeInteger(value))).toBe(true);
  });

  it("refuses a base too large to reach level one", () => {
    // The table would truncate to [0] - a curve nobody can ever level up in,
    // reported as if it were fine.
    expect(() => new LinearCurve({ base: MAX_TOTAL_XP + 1, maxLevel: 10 })).toThrow(
      ConfigurationError,
    );
    expect(() => new QuadraticCurve({ base: MAX_TOTAL_XP + 1, maxLevel: 10 })).toThrow(
      ConfigurationError,
    );
    // One below is still a usable, if absurd, curve with exactly one level.
    expect(new LinearCurve({ base: MAX_TOTAL_XP, maxLevel: 10 }).maxLevel).toBe(1);
  });

  it("builds the quadratic table exactly, however large the base", () => {
    const curve = new QuadraticCurve({ base: 9_007_199_254_740, maxLevel: 1000 });
    expect(curve.maxLevel).toBe(44);
    expect(curve.thresholds[44]).toBe(8917127262192600);
    // total(L) = base * L * (L + 1) / 2, checked against BigInt rather than
    // against the same double arithmetic the implementation used to use.
    for (let level = 0; level <= curve.maxLevel; level += 1) {
      const exact =
        (BigInt(9_007_199_254_740) * BigInt(level) * BigInt(level + 1)) / 2n;
      expect(BigInt(curve.thresholds[level] as number)).toBe(exact);
    }
  });
});

describe("magnitudes: progress on a wide level", () => {
  // `xpIntoLevel * 1000` passes 2^53 for any level wider than about 9e12, and a
  // TabularCurve can be handed one directly.
  it.each([
    { span: 5002985382580839, into: 3191904674086575, permille: 637 },
    { span: 7258011449013000, into: 6430598143825518, permille: 886 },
    { span: 5307722243584428, into: 3216479679612163, permille: 605 },
    { span: 5671046042530894, into: 4327008130451072, permille: 762 },
    { span: 7379154009697730, into: 7371774855688032, permille: 998 },
  ])("reports $permille permille for a span of $span", ({ span, into, permille }) => {
    const curve = new TabularCurve([0, span, MAX_TOTAL_XP]);
    expect(curve.progressForTotalXp(into).progressPermille).toBe(permille);
  });

  it("never reports more than 1000 permille, however wide the level", () => {
    const curve = new TabularCurve([0, 4503599627370496, MAX_TOTAL_XP]);
    for (const total of [0, 1, 4503599627370495, 4503599627370496, MAX_TOTAL_XP]) {
      const progress = curve.progressForTotalXp(total);
      expect(progress.progressPermille).toBeGreaterThanOrEqual(0);
      expect(progress.progressPermille).toBeLessThanOrEqual(1000);
    }
  });
});

describe("magnitudes: multiplier chains", () => {
  it("multiplies exactly where a double would round", () => {
    expect(applyMultipliers(2848452375478271, [{ source: "r", permille: 2490 }])).toBe(
      7092646414940894,
    );
  });

  it("floors at every step, exactly, all the way down a chain", () => {
    // Compared against BigInt, which is what the Python edition's integers do.
    let expected = BigInt(4_503_599_627_370);
    const chain = [1500, 999, 1001, 700, 1234].map((permille, index) => ({
      source: `s${index}`,
      permille,
    }));
    for (const { permille } of chain) {
      expected = (expected * BigInt(permille)) / 1000n;
    }
    expect(applyMultipliers(4_503_599_627_370, chain)).toBe(Number(expected));
  });

  it("refuses a chain that leaves the shared safe range", () => {
    // Python could hold the answer; JavaScript could not. A total only one
    // edition can hold is exactly what the shared range exists to prevent.
    expect(() =>
      applyMultipliers(MAX_TOTAL_XP, [{ source: "double-xp", permille: 2000 }]),
    ).toThrow(XpOverflowError);
    // Two factors of a million still fit (1000 -> 1e9 -> 1e15); the third does
    // not. The guard is on the running value, so it fires on that step.
    expect(
      combinedPermille([
        { source: "a", permille: 1_000_000_000 },
        { source: "b", permille: 1_000_000_000 },
      ]),
    ).toBe(1_000_000_000_000_000);
    expect(() =>
      combinedPermille([
        { source: "a", permille: 1_000_000_000 },
        { source: "b", permille: 1_000_000_000 },
        { source: "c", permille: 1_000_000_000 },
      ]),
    ).toThrow(XpOverflowError);
  });
});

describe("magnitudes: migration between wide curves", () => {
  it("carries the progress bar across without rounding it", () => {
    const from = new TabularCurve([0, 1000, 2000]);
    const to = new TabularCurve([0, 4503599627370496, MAX_TOTAL_XP]);
    const result = migrateTotalXp(1234, from, to, MigrationStrategy.PreserveProgress);
    expect(result.newTotalXp).toBe(5557441940175191);
    expect(result.newLevel).toBe(1);
  });
});

describe("magnitudes: the ceiling", () => {
  it("awards exactly the headroom and no more", () => {
    const engine = new RankEngine({
      curve: createCurve({ kind: "quadratic", base: 100, maxLevel: 10 }),
      rules: [{ eventType: "message", minXp: 1000, maxXp: 1000 }],
    });
    const state = createMemberState(MAX_TOTAL_XP - 7);
    const result = engine.award(state, "message", { now: 1 });
    expect(result.awardedXp).toBe(7);
    expect(result.newTotalXp).toBe(MAX_TOTAL_XP);

    const again = engine.award(result.state, "message", { now: 2 });
    expect(again.outcome).toBe("MAX_XP_REACHED");
    expect(again.newTotalXp).toBe(MAX_TOTAL_XP);
  });
});
