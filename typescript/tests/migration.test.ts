import { describe, it, expect } from "vitest";
import {
  ExponentialCurve,
  LinearCurve,
  migrateAll,
  migrateTotalXp,
  MigrationError,
  MigrationStrategy,
  previewMigration,
  QuadraticCurve,
} from "../src/index.js";

const linear = new LinearCurve({ base: 100, maxLevel: 50 });
const quadratic = new QuadraticCurve({ base: 100, maxLevel: 50 });
const exponential = new ExponentialCurve({
  base: 100,
  growthPermille: 1500,
  maxLevel: 50,
});

describe("migrateTotalXp", () => {
  it("preserves the level and the bar by default", () => {
    // linear: level 3 at 300, level 4 at 400, so 350 is halfway.
    const result = migrateTotalXp(350, linear, quadratic);
    expect(result.previousLevel).toBe(3);
    expect(result.newLevel).toBe(3);
    expect(result.previousProgressPermille).toBe(500);
    // quadratic: level 3 at 600, level 4 at 1000 -> halfway is 800.
    expect(result.newTotalXp).toBe(800);
    expect(result.newProgressPermille).toBe(500);
    expect(result.levelDelta).toBe(0);
  });

  it("preserves the level but empties the bar on request", () => {
    const result = migrateTotalXp(350, linear, quadratic, MigrationStrategy.PreserveLevel);
    expect(result.newLevel).toBe(3);
    expect(result.newTotalXp).toBe(600);
    expect(result.newProgressPermille).toBe(0);
  });

  it("keeps the raw total when asked to", () => {
    const result = migrateTotalXp(350, linear, quadratic, MigrationStrategy.PreserveXp);
    expect(result.newTotalXp).toBe(350);
    expect(result.previousLevel).toBe(3);
    // quadratic level 2 starts at 300, level 3 at 600 — so the member drops one.
    expect(result.newLevel).toBe(2);
    expect(result.levelDelta).toBe(-1);
  });

  it("never gives a free level through rounding", () => {
    // Whatever the curves, a preserved-progress migration lands inside the
    // same level, never in the one above.
    for (let totalXp = 0; totalXp <= 5000; totalXp += 7) {
      const result = migrateTotalXp(totalXp, linear, quadratic);
      expect(result.newLevel).toBe(result.previousLevel);
    }
  });

  it("never takes a level away, in either direction", () => {
    for (let totalXp = 0; totalXp <= 5000; totalXp += 13) {
      expect(migrateTotalXp(totalXp, quadratic, linear).levelDelta).toBe(0);
      expect(migrateTotalXp(totalXp, quadratic, exponential).levelDelta).toBe(0);
      expect(migrateTotalXp(totalXp, exponential, quadratic).levelDelta).toBe(0);
    }
  });

  it("is a no-op when both curves are the same shape", () => {
    const result = migrateTotalXp(1234, quadratic, new QuadraticCurve({ base: 100, maxLevel: 50 }));
    expect(result.newTotalXp).toBe(1234);
  });

  it("clamps a member above the top of the new curve", () => {
    const shortCurve = new LinearCurve({ base: 100, maxLevel: 3 });
    const result = migrateTotalXp(quadratic.totalXpForLevel(10), quadratic, shortCurve);
    expect(result.newLevel).toBe(3);
    expect(result.clampedToCurveTop).toBe(true);
  });

  it("handles a member at level 0", () => {
    const result = migrateTotalXp(0, linear, quadratic);
    expect(result.newTotalXp).toBe(0);
    expect(result.newLevel).toBe(0);
  });

  it("rejects an unknown strategy", () => {
    expect(() => migrateTotalXp(100, linear, quadratic, "SPIN" as never)).toThrow(
      MigrationError,
    );
  });
});

describe("migrateAll", () => {
  it("keeps the input order", () => {
    const results = migrateAll([0, 100, 350, 1000], linear, quadratic);
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.previousTotalXp)).toEqual([0, 100, 350, 1000]);
  });
});

describe("previewMigration", () => {
  const totals = [0, 50, 150, 350, 900, 5000];

  it("summarises what the switch would do", () => {
    const report = previewMigration(totals, linear, quadratic);
    expect(report.memberCount).toBe(6);
    expect(report.unchanged).toBe(6);
    expect(report.lostLevels).toBe(0);
    expect(report.safeForMembers).toBe(true);
    expect(report.totalXpBefore).toBe(6450);
    expect(report.totalXpAfter).toBeGreaterThan(report.totalXpBefore);
  });

  it("flags a strategy that costs members their level", () => {
    const report = previewMigration(totals, linear, quadratic, MigrationStrategy.PreserveXp);
    expect(report.safeForMembers).toBe(false);
    expect(report.lostLevels).toBeGreaterThan(0);
    expect(report.maxLoss).toBeGreaterThan(0);
    expect(report.totalXpAfter).toBe(report.totalXpBefore);
  });

  it("counts gained levels too", () => {
    const report = previewMigration(totals, quadratic, linear, MigrationStrategy.PreserveXp);
    expect(report.gainedLevels).toBeGreaterThan(0);
    expect(report.maxGain).toBeGreaterThan(0);
  });

  it("handles an empty scope", () => {
    const report = previewMigration([], linear, quadratic);
    expect(report.memberCount).toBe(0);
    expect(report.safeForMembers).toBe(true);
  });
});
