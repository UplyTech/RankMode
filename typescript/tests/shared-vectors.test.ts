import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  applyMultipliers,
  buildLeaderboard,
  createCurve,
  createEventRule,
  createMemberState,
  FixedRandomSource,
  migrateTotalXp,
  RankEngine,
  SeededRandomSource,
  rankOf,
  type AwardResult,
  type CurveSpec,
  type DecayRule,
  type EventRuleInput,
  type GlobalCap,
  type MigrationStrategy,
  type TieMode,
} from "../src/index.js";

/**
 * The shared vectors are the contract between the Python and the TypeScript
 * edition. Both run this same set of cases; a difference in either edition
 * turns into a red build here rather than into two communities whose members
 * hold different levels for the same activity.
 */

const vectorDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "shared",
  "testcases",
);

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(vectorDir, `${name}.json`), "utf8")) as T;
}

describe("shared vectors: curves", () => {
  const data = load<{
    formatVersion: number;
    curves: {
      id: string;
      spec: CurveSpec;
      maxLevel: number;
      thresholds: number[];
      probes: {
        totalXp: number;
        level: number;
        currentThreshold: number;
        nextThreshold: number | null;
        xpIntoLevel: number;
        xpToNext: number | null;
        levelSpan: number | null;
        progressPermille: number;
        isMaxLevel: boolean;
      }[];
    }[];
  }>("curves");

  it("uses a format version this edition understands", () => {
    expect(data.formatVersion).toBe(1);
  });

  for (const entry of data.curves) {
    it(`reproduces the ${entry.id} threshold table`, () => {
      const curve = createCurve(entry.spec);
      expect(curve.maxLevel).toBe(entry.maxLevel);
      expect([...curve.thresholds]).toEqual(entry.thresholds);
    });

    it(`reproduces ${entry.id} progress for every probe`, () => {
      const curve = createCurve(entry.spec);
      for (const probe of entry.probes) {
        const progress = curve.progressForTotalXp(probe.totalXp);
        expect({
          totalXp: progress.totalXp,
          level: progress.level,
          currentThreshold: progress.currentThreshold,
          nextThreshold: progress.nextThreshold,
          xpIntoLevel: progress.xpIntoLevel,
          xpToNext: progress.xpToNext,
          levelSpan: progress.levelSpan,
          progressPermille: progress.progressPermille,
          isMaxLevel: progress.isMaxLevel,
        }).toEqual(probe);
      }
    });
  }
});

describe("shared vectors: multipliers", () => {
  const data = load<{
    cases: { baseXp: number; permilles: number[]; expected: number }[];
  }>("multipliers");

  it("reproduces every multiplier chain", () => {
    for (const testCase of data.cases) {
      const result = applyMultipliers(
        testCase.baseXp,
        testCase.permilles.map((permille, index) => ({ source: `m${index}`, permille })),
      );
      expect(result).toBe(testCase.expected);
    }
  });
});

describe("shared vectors: seeded random source", () => {
  const data = load<{
    seeds: { seed: number; next32: number[]; randomInt15to25: number[] }[];
  }>("random");

  for (const entry of data.seeds) {
    it(`reproduces the mulberry32 stream for seed ${entry.seed}`, () => {
      const raw = new SeededRandomSource(entry.seed);
      expect(entry.next32.map(() => raw.next32())).toEqual(entry.next32);

      const span = new SeededRandomSource(entry.seed);
      expect(entry.randomInt15to25.map(() => span.randomInt(15, 25))).toEqual(
        entry.randomInt15to25,
      );
    });
  }
});

interface AwardStep {
  kind?: "penalize" | "decay";
  eventType?: string;
  amount?: number;
  nowOffsetMs: number;
  multipliers?: { source: string; permille: number }[];
  expected: {
    outcome: string;
    awardedXp: number;
    baseXp: number;
    multiplierPermille: number;
    previousTotalXp: number;
    newTotalXp: number;
    previousLevel: number;
    newLevel: number;
    leveledUp: boolean;
    leveledDown: boolean;
    progressPermille: number;
    cooldownRemainingMs: number;
    periodRemainingXp: number | null;
  };
}

describe("shared vectors: awards", () => {
  const data = load<{
    baseTimestampMs: number;
    scenarios: {
      id: string;
      description: string;
      config: {
        curve: CurveSpec;
        rules?: EventRuleInput[];
        globalCap?: GlobalCap;
        decay?: DecayRule;
        allowNegative?: boolean;
      };
      initialTotalXp: number;
      randomValues: number[];
      steps: AwardStep[];
      finalTotalXp: number;
    }[];
  }>("awards");

  for (const scenario of data.scenarios) {
    it(`replays ${scenario.id}: ${scenario.description}`, () => {
      const engine = new RankEngine({
        curve: createCurve(scenario.config.curve),
        rules: (scenario.config.rules ?? []).map((rule) => createEventRule(rule)),
        globalCap: scenario.config.globalCap ?? null,
        decay: scenario.config.decay ?? null,
        allowNegative: scenario.config.allowNegative ?? false,
      });
      const random = new FixedRandomSource(scenario.randomValues);
      let state = createMemberState(scenario.initialTotalXp);

      for (const step of scenario.steps) {
        const now = data.baseTimestampMs + step.nowOffsetMs;
        let result: AwardResult;
        if (step.kind === "penalize") {
          result = engine.penalize(state, step.amount as number, { now });
        } else if (step.kind === "decay") {
          result = engine.applyDecay(state, { now });
        } else {
          result = engine.award(state, step.eventType as string, {
            now,
            random,
            multipliers: step.multipliers ?? [],
          });
        }
        state = result.state;

        expect({
          outcome: result.outcome as string,
          awardedXp: result.awardedXp,
          baseXp: result.baseXp,
          multiplierPermille: result.multiplierPermille,
          previousTotalXp: result.previousTotalXp,
          newTotalXp: result.newTotalXp,
          previousLevel: result.previousLevel,
          newLevel: result.newLevel,
          leveledUp: result.leveledUp,
          leveledDown: result.leveledDown,
          progressPermille: result.progress.progressPermille,
          cooldownRemainingMs: result.cooldownRemainingMs,
          periodRemainingXp: result.periodRemainingXp,
        }).toEqual(step.expected);
      }

      expect(state.totalXp).toBe(scenario.finalTotalXp);
    });
  }
});

describe("shared vectors: leaderboard", () => {
  const data = load<{
    curve: CurveSpec;
    rows: { memberId: string; totalXp: number }[];
    boards: {
      tieMode: TieMode;
      entries: {
        memberId: string;
        totalXp: number;
        level: number;
        rank: number;
        competitionRank: number;
        denseRank: number;
        position: number;
        progressPermille: number;
      }[];
      rankOf: Record<string, number>;
    }[];
    paging: { offset: number; limit: number; memberIds: string[] };
  }>("leaderboard");

  const curve = createCurve(data.curve);

  for (const board of data.boards) {
    it(`reproduces the ${board.tieMode} board`, () => {
      const built = buildLeaderboard(curve, data.rows, { tieMode: board.tieMode });
      expect(
        built.map((entry) => ({
          memberId: entry.memberId,
          totalXp: entry.totalXp,
          level: entry.level,
          rank: entry.rank,
          competitionRank: entry.competitionRank,
          denseRank: entry.denseRank,
          position: entry.position,
          progressPermille: entry.progress.progressPermille,
        })),
      ).toEqual(board.entries);
    });

    it(`reproduces ${board.tieMode} single-member ranks`, () => {
      for (const [memberId, expected] of Object.entries(board.rankOf)) {
        expect(rankOf(memberId, data.rows, { tieMode: board.tieMode })).toBe(expected);
      }
    });
  }

  it("reproduces the paged board", () => {
    const built = buildLeaderboard(curve, data.rows, {
      offset: data.paging.offset,
      limit: data.paging.limit,
    });
    expect(built.map((entry) => entry.memberId)).toEqual(data.paging.memberIds);
  });
});

describe("shared vectors: migration", () => {
  const data = load<{
    cases: {
      id: string;
      from: CurveSpec;
      to: CurveSpec;
      strategy: MigrationStrategy;
      results: {
        previousTotalXp: number;
        newTotalXp: number;
        previousLevel: number;
        newLevel: number;
        levelDelta: number;
        previousProgressPermille: number;
        newProgressPermille: number;
        clampedToCurveTop: boolean;
      }[];
    }[];
  }>("migration");

  for (const testCase of data.cases) {
    it(`reproduces ${testCase.id}`, () => {
      const from = createCurve(testCase.from);
      const to = createCurve(testCase.to);
      for (const expected of testCase.results) {
        const result = migrateTotalXp(
          expected.previousTotalXp,
          from,
          to,
          testCase.strategy,
        );
        expect({
          previousTotalXp: result.previousTotalXp,
          newTotalXp: result.newTotalXp,
          previousLevel: result.previousLevel,
          newLevel: result.newLevel,
          levelDelta: result.levelDelta,
          previousProgressPermille: result.previousProgressPermille,
          newProgressPermille: result.newProgressPermille,
          clampedToCurveTop: result.clampedToCurveTop,
        }).toEqual(expected);
      }
    });
  }
});
