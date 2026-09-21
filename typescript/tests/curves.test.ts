import { describe, it, expect } from "vitest";
import {
  ConfigurationError,
  createCurve,
  CurveError,
  defaultCurve,
  ExponentialCurve,
  LinearCurve,
  QuadraticCurve,
  TabularCurve,
  ValidationError,
  MAX_SUPPORTED_LEVEL,
} from "../src/index.js";

describe("LinearCurve", () => {
  it("charges the same for every level", () => {
    const curve = new LinearCurve({ base: 100, maxLevel: 5 });
    expect([...curve.thresholds]).toEqual([0, 100, 200, 300, 400, 500]);
    expect(curve.maxLevel).toBe(5);
  });

  it("maps totals to levels", () => {
    const curve = new LinearCurve({ base: 100, maxLevel: 5 });
    expect(curve.levelForTotalXp(0)).toBe(0);
    expect(curve.levelForTotalXp(99)).toBe(0);
    expect(curve.levelForTotalXp(100)).toBe(1);
    expect(curve.levelForTotalXp(250)).toBe(2);
    expect(curve.levelForTotalXp(500)).toBe(5);
    expect(curve.levelForTotalXp(999999)).toBe(5);
  });

  it("round-trips through createCurve", () => {
    const curve = new LinearCurve({ base: 250, maxLevel: 12 });
    const rebuilt = createCurve(curve.toJSON());
    expect([...rebuilt.thresholds]).toEqual([...curve.thresholds]);
  });
});

describe("QuadraticCurve", () => {
  it("is the triangular series, so level cost grows evenly", () => {
    const curve = new QuadraticCurve({ base: 100, maxLevel: 5 });
    expect([...curve.thresholds]).toEqual([0, 100, 300, 600, 1000, 1500]);
  });

  it("never produces a fractional threshold", () => {
    const curve = new QuadraticCurve({ base: 25, maxLevel: 200 });
    for (const threshold of curve.thresholds) {
      expect(Number.isInteger(threshold)).toBe(true);
    }
  });

  it("costs one more base per level", () => {
    const curve = new QuadraticCurve({ base: 100, maxLevel: 10 });
    expect(curve.xpForNextLevel(1)).toBe(200);
    expect(curve.xpForNextLevel(2)).toBe(300);
    expect(curve.xpForNextLevel(3)).toBe(400);
  });

  it("is the default curve", () => {
    expect(defaultCurve()).toBeInstanceOf(QuadraticCurve);
  });
});

describe("ExponentialCurve", () => {
  it("multiplies the level cost by the growth factor", () => {
    const curve = new ExponentialCurve({ base: 100, growthPermille: 1500, maxLevel: 5 });
    // costs: 100, 150, 225, 337, 505
    expect([...curve.thresholds]).toEqual([0, 100, 250, 475, 812, 1317]);
  });

  it("uses integer floor division so both editions agree", () => {
    const curve = new ExponentialCurve({ base: 7, growthPermille: 1010, maxLevel: 4 });
    // costs: 7, floor(7*1.01)=7 -> forced to 8, floor(8*1.01)=8 -> 9, 9
    expect(curve.thresholds[1]).toBe(7);
    for (let level = 2; level <= 4; level += 1) {
      const step =
        (curve.thresholds[level] as number) - (curve.thresholds[level - 1] as number);
      expect(step).toBeGreaterThan(0);
    }
  });

  it("stops the table before leaving the safe integer range", () => {
    const curve = new ExponentialCurve({ base: 100, growthPermille: 2000, maxLevel: 1000 });
    expect(curve.maxLevel).toBeLessThan(1000);
    expect(curve.thresholds[curve.maxLevel]).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a growth factor of 1.0 or below", () => {
    expect(() => new ExponentialCurve({ growthPermille: 1000 })).toThrow(ConfigurationError);
    expect(() => new ExponentialCurve({ growthPermille: 900 })).toThrow(ConfigurationError);
  });
});

describe("TabularCurve", () => {
  it("takes operator supplied thresholds", () => {
    const curve = new TabularCurve([0, 10, 50, 500]);
    expect(curve.maxLevel).toBe(3);
    expect(curve.levelForTotalXp(49)).toBe(1);
    expect(curve.levelForTotalXp(50)).toBe(2);
  });

  it("rejects a table that does not start at zero", () => {
    expect(() => new TabularCurve([10, 20])).toThrow(ConfigurationError);
  });

  it("rejects a table that does not ascend", () => {
    expect(() => new TabularCurve([0, 100, 100])).toThrow(ConfigurationError);
    expect(() => new TabularCurve([0, 100, 50])).toThrow(ConfigurationError);
  });

  it("rejects a table with a single entry", () => {
    expect(() => new TabularCurve([0])).toThrow(ConfigurationError);
  });

  it("rejects a table beyond the supported level range", () => {
    const thresholds = [0];
    for (let i = 1; i <= MAX_SUPPORTED_LEVEL + 1; i += 1) {
      thresholds.push(i);
    }
    expect(() => new TabularCurve(thresholds)).toThrow(ConfigurationError);
  });

  it("rejects a non-integer threshold", () => {
    expect(() => new TabularCurve([0, 10.5])).toThrow(ConfigurationError);
  });
});

describe("serialisation", () => {
  it("round-trips every generated shape", () => {
    const curves = [
      new LinearCurve({ base: 60, maxLevel: 8 }),
      new QuadraticCurve({ base: 75, maxLevel: 9 }),
      new ExponentialCurve({ base: 40, growthPermille: 1250, maxLevel: 7 }),
    ];
    for (const curve of curves) {
      const spec = curve.toJSON();
      expect(spec.kind).toBe(curve.kind);
      const rebuilt = createCurve(spec);
      expect([...rebuilt.thresholds]).toEqual([...curve.thresholds]);
    }
  });

  it("serialises a hand-written table as a table", () => {
    const curve = new TabularCurve([0, 10, 40, 90]);
    const spec = curve.toJSON();
    expect(spec).toEqual({ kind: "tabular", thresholds: [0, 10, 40, 90] });
    expect([...createCurve(spec).thresholds]).toEqual([0, 10, 40, 90]);
  });

  it("keeps a truncated exponential table reproducible", () => {
    const curve = new ExponentialCurve({ base: 100, growthPermille: 2000, maxLevel: 1000 });
    const rebuilt = createCurve(curve.toJSON());
    expect(rebuilt.maxLevel).toBe(curve.maxLevel);
    expect([...rebuilt.thresholds]).toEqual([...curve.thresholds]);
  });
});

describe("progressForTotalXp", () => {
  const curve = new QuadraticCurve({ base: 100, maxLevel: 5 });

  it("reports the position inside the level", () => {
    const progress = curve.progressForTotalXp(200);
    expect(progress.level).toBe(1);
    expect(progress.currentThreshold).toBe(100);
    expect(progress.nextThreshold).toBe(300);
    expect(progress.xpIntoLevel).toBe(100);
    expect(progress.xpToNext).toBe(100);
    expect(progress.levelSpan).toBe(200);
    expect(progress.progressPermille).toBe(500);
    expect(progress.isMaxLevel).toBe(false);
  });

  it("reports a full bar at the top of the curve", () => {
    const progress = curve.progressForTotalXp(1500);
    expect(progress.level).toBe(5);
    expect(progress.nextThreshold).toBeNull();
    expect(progress.xpToNext).toBeNull();
    expect(progress.levelSpan).toBeNull();
    expect(progress.progressPermille).toBe(1000);
    expect(progress.isMaxLevel).toBe(true);
  });

  it("keeps counting XP past the top of the curve", () => {
    const progress = curve.progressForTotalXp(99999);
    expect(progress.level).toBe(5);
    expect(progress.xpIntoLevel).toBe(99999 - 1500);
  });

  it("floors progress rather than rounding it", () => {
    // level 1 spans 100..300; 199 is 99/200 = 495 permille exactly
    expect(curve.progressForTotalXp(199).progressPermille).toBe(495);
    // 101 is 1/200 = 5 permille
    expect(curve.progressForTotalXp(101).progressPermille).toBe(5);
  });

  it("treats a negative total as level 0 with an empty bar", () => {
    const progress = curve.progressForTotalXp(-50);
    expect(progress.level).toBe(0);
    expect(progress.xpIntoLevel).toBe(-50);
    expect(progress.progressPermille).toBe(0);
  });
});

describe("curve error handling", () => {
  const curve = new QuadraticCurve({ base: 100, maxLevel: 3 });

  it("refuses a level above the curve", () => {
    expect(() => curve.totalXpForLevel(4)).toThrow(CurveError);
    expect(() => curve.xpForNextLevel(3)).toThrow(CurveError);
  });

  it("refuses a negative or fractional level", () => {
    expect(() => curve.totalXpForLevel(-1)).toThrow(ValidationError);
    expect(() => curve.totalXpForLevel(1.5)).toThrow(ValidationError);
  });

  it("refuses a non-finite total", () => {
    expect(() => curve.levelForTotalXp(Number.NaN)).toThrow(ValidationError);
    expect(() => curve.levelForTotalXp(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });

  it("treats level 0 as the cost of the first level", () => {
    expect(curve.xpForNextLevel(0)).toBe(100);
  });

  it("refuses an unusable base", () => {
    expect(() => new LinearCurve({ base: 0 })).toThrow(ConfigurationError);
    expect(() => new QuadraticCurve({ base: -5 })).toThrow(ConfigurationError);
    expect(() => new LinearCurve({ maxLevel: 0 })).toThrow(ConfigurationError);
    expect(() => new LinearCurve({ maxLevel: MAX_SUPPORTED_LEVEL + 1 })).toThrow(
      ConfigurationError,
    );
  });

  it("refuses an unknown curve kind", () => {
    expect(() => createCurve({ kind: "spiral" } as never)).toThrow(ConfigurationError);
  });
});
