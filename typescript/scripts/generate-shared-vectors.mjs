/**
 * Regenerate ../../shared/testcases/*.json from this edition.
 *
 * Run `npm run build` first, then `node scripts/generate-shared-vectors.mjs`.
 *
 * The vectors are the contract between the Python and the TypeScript edition.
 * Regenerating them is therefore a deliberate act: if a vector changes, the
 * behaviour of the library changed, and the change belongs in the changelog
 * with the version bump the concept asks for. Never regenerate to make a
 * failing test pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AwardOutcome,
  applyLeaguePoints,
  applyMultipliers,
  balanceTeams,
  buildLeaderboard,
  createCurve,
  createEventRule,
  createLadderConfig,
  createLadderPosition,
  createMemberState,
  createRankedConfig,
  createRankedState,
  createRating,
  createSeason,
  createSeasonResetConfig,
  createSeriesState,
  Division,
  expectedScorePermille,
  FixedRandomSource,
  formatPosition,
  matchQuality,
  MatchOutcome,
  migrateTotalXp,
  MigrationStrategy,
  positionForRating,
  RankedEngine,
  RankEngine,
  ratingForPosition,
  ratingInterval,
  RatingSystem,
  resetRating,
  ResetPolicy,
  SeededRandomSource,
  serializeRankedState,
  rankOf,
  teamRating,
  Tier,
  TieMode,
  updateElo,
  updateGlicko2,
} from "../dist/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "shared", "testcases");
mkdirSync(outDir, { recursive: true });

const FORMAT_VERSION = 1;

function write(name, payload) {
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`wrote ${file}`);
}

// --------------------------------------------------------------------------
// curves
// --------------------------------------------------------------------------

const curveSpecs = [
  { id: "linear-100", spec: { kind: "linear", base: 100, maxLevel: 20 } },
  { id: "linear-50", spec: { kind: "linear", base: 50, maxLevel: 10 } },
  { id: "quadratic-100", spec: { kind: "quadratic", base: 100, maxLevel: 20 } },
  { id: "quadratic-25", spec: { kind: "quadratic", base: 25, maxLevel: 30 } },
  {
    id: "exponential-100-1500",
    spec: { kind: "exponential", base: 100, growthPermille: 1500, maxLevel: 15 },
  },
  {
    id: "exponential-7-1010",
    spec: { kind: "exponential", base: 7, growthPermille: 1010, maxLevel: 12 },
  },
  { id: "tabular-custom", spec: { kind: "tabular", thresholds: [0, 5, 25, 125, 625] } },

  // ------------------------------------------------------------------------
  // Everything above works below 10^6, and that is exactly how three separate
  // divergences survived to 1.0.0: all of them appear only when an
  // *intermediate* product passes 2^53 - 1, while the inputs and the answer
  // stay comfortably inside it.
  //
  // The four exponential specs below each built a *different threshold table*
  // in the two editions. The wide tabular curves have levels broad enough that
  // `xpIntoLevel * 1000` overflows, which is where the progress bar diverged.
  // ------------------------------------------------------------------------
  {
    id: "exponential-1000000003-1500",
    spec: { kind: "exponential", base: 1_000_000_003, growthPermille: 1500, maxLevel: 500 },
  },
  {
    id: "exponential-999-3000",
    spec: { kind: "exponential", base: 999, growthPermille: 3000, maxLevel: 500 },
  },
  {
    id: "exponential-1000000003-3000",
    spec: { kind: "exponential", base: 1_000_000_003, growthPermille: 3000, maxLevel: 500 },
  },
  {
    id: "exponential-9007199254740-1500",
    spec: { kind: "exponential", base: 9_007_199_254_740, growthPermille: 1500, maxLevel: 500 },
  },
  {
    id: "quadratic-9007199254740",
    spec: { kind: "quadratic", base: 9_007_199_254_740, maxLevel: 1000 },
  },
  {
    id: "linear-9007199254740",
    spec: { kind: "linear", base: 9_007_199_254_740, maxLevel: 1000 },
  },
  {
    id: "tabular-wide",
    spec: { kind: "tabular", thresholds: [0, 5002985382580839, 9007199254740991] },
  },
  {
    id: "tabular-half-range",
    spec: { kind: "tabular", thresholds: [0, 4503599627370496, 9007199254740991] },
  },
];

const probeTotals = [
  -100, 0, 1, 24, 25, 49, 50, 99, 100, 101, 149, 150, 299, 300, 301, 599, 600,
  999, 1000, 1499, 1500, 5000, 12_345, 1_000_000,

  // The magnitudes at which the editions used to disagree. Each of the first
  // five sits inside a wide level, where the permille calculation overflows;
  // the rest bracket the safe-integer boundary itself.
  3_191_904_674_086_575, 6_430_598_143_825_518, 3_216_479_679_612_163,
  4_327_008_130_451_072, 7_371_774_855_688_032,
  4_503_599_627_370_495, 4_503_599_627_370_496, 4_503_599_627_370_497,
  9_007_199_254_740_990, 9_007_199_254_740_991,
];

write("curves", {
  formatVersion: FORMAT_VERSION,
  description:
    "Threshold tables, level lookups and progress for every shipped curve shape. Both editions must reproduce these numbers exactly.",
  curves: curveSpecs.map(({ id, spec }) => {
    const curve = createCurve(spec);
    return {
      id,
      spec,
      maxLevel: curve.maxLevel,
      thresholds: [...curve.thresholds],
      probes: probeTotals.map((totalXp) => {
        const progress = curve.progressForTotalXp(totalXp);
        return {
          totalXp,
          level: progress.level,
          currentThreshold: progress.currentThreshold,
          nextThreshold: progress.nextThreshold,
          xpIntoLevel: progress.xpIntoLevel,
          xpToNext: progress.xpToNext,
          levelSpan: progress.levelSpan,
          progressPermille: progress.progressPermille,
          isMaxLevel: progress.isMaxLevel,
        };
      }),
    };
  }),
});

// --------------------------------------------------------------------------
// multipliers
// --------------------------------------------------------------------------

const multiplierChains = [
  { baseXp: 20, permilles: [] },
  { baseXp: 20, permilles: [2000] },
  { baseXp: 20, permilles: [500] },
  { baseXp: 20, permilles: [0] },
  { baseXp: 10, permilles: [1500, 1500] },
  { baseXp: 7, permilles: [1500, 1100] },
  { baseXp: 7, permilles: [1100, 1500] },
  { baseXp: 1, permilles: [1999] },
  { baseXp: 3, permilles: [333, 3000] },
  { baseXp: 999, permilles: [1001, 1001, 1001] },

  // Large enough that the running value passes 2^53 mid-chain. Every one of
  // these returned a different number in each edition until 2.0.0.
  { baseXp: 2_848_452_375_478_271, permilles: [2490] },
  { baseXp: 8_196_356_673_896_447, permilles: [1000] },
  { baseXp: 3_654_325_679_161_343, permilles: [1500, 999] },
  { baseXp: 4_503_599_627_370, permilles: [1500, 999, 1001, 700, 1234] },
  { baseXp: 9_007_199_254_740_991, permilles: [1000] },
  { baseXp: 9_007_199_254_740_991, permilles: [999] },
];

write("multipliers", {
  formatVersion: FORMAT_VERSION,
  description:
    "Integer permille multiplier chains. Each factor is applied in order with floor division, so the order is part of the contract.",
  cases: multiplierChains.map(({ baseXp, permilles }) => ({
    baseXp,
    permilles,
    expected: applyMultipliers(
      baseXp,
      permilles.map((permille, index) => ({ source: `m${index}`, permille })),
    ),
  })),
});

// --------------------------------------------------------------------------
// seeded random source
// --------------------------------------------------------------------------

write("random", {
  formatVersion: FORMAT_VERSION,
  description:
    "The seeded source is mulberry32, small enough to reimplement identically everywhere. It exists for tests and for reproducing a reported award; production code uses the cryptographic source.",
  seeds: [0, 1, 42, 12345, 2147483647, 4294967295].map((seed) => {
    const raw = new SeededRandomSource(seed);
    const span = new SeededRandomSource(seed);
    return {
      seed,
      next32: Array.from({ length: 10 }, () => raw.next32()),
      randomInt15to25: Array.from({ length: 10 }, () => span.randomInt(15, 25)),
    };
  }),
});

// --------------------------------------------------------------------------
// awards
// --------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const awardScenarios = [
  {
    id: "cooldown-and-levelup",
    description:
      "A member earns, is blocked by the cooldown, earns again and crosses into level 1.",
    config: {
      curve: { kind: "quadratic", base: 100, maxLevel: 20 },
      rules: [
        {
          eventType: "message",
          minXp: 15,
          maxXp: 25,
          cooldownSeconds: 60,
          periodCapXp: 1000,
        },
      ],
    },
    initialTotalXp: 60,
    randomValues: [20, 25, 15],
    steps: [
      { eventType: "message", nowOffsetMs: 0 },
      { eventType: "message", nowOffsetMs: 30_000 },
      { eventType: "message", nowOffsetMs: 60_000 },
      { eventType: "message", nowOffsetMs: 180_000 },
    ],
  },
  {
    id: "period-cap-trim",
    description:
      "The daily cap trims the last award of the period and blocks the one after it.",
    config: {
      curve: { kind: "linear", base: 100, maxLevel: 20 },
      rules: [
        {
          eventType: "message",
          minXp: 30,
          maxXp: 30,
          cooldownSeconds: 0,
          periodCapXp: 100,
          periodSeconds: 3600,
        },
      ],
    },
    initialTotalXp: 0,
    randomValues: [30],
    steps: [
      { eventType: "message", nowOffsetMs: 0 },
      { eventType: "message", nowOffsetMs: 1_000 },
      { eventType: "message", nowOffsetMs: 2_000 },
      { eventType: "message", nowOffsetMs: 3_000 },
      { eventType: "message", nowOffsetMs: 4_000 },
      { eventType: "message", nowOffsetMs: 3_600_000 },
    ],
  },
  {
    id: "multipliers-and-global-cap",
    description:
      "A double-XP weekend runs into the cross-event global cap.",
    config: {
      curve: { kind: "quadratic", base: 100, maxLevel: 20 },
      rules: [
        { eventType: "message", minXp: 20, maxXp: 20, cooldownSeconds: 0 },
        { eventType: "reaction", minXp: 10, maxXp: 10, cooldownSeconds: 0 },
      ],
      globalCap: { xp: 100, periodSeconds: 86400 },
    },
    initialTotalXp: 0,
    randomValues: [20],
    steps: [
      {
        eventType: "message",
        nowOffsetMs: 0,
        multipliers: [{ source: "weekend", permille: 2000 }],
      },
      {
        eventType: "message",
        nowOffsetMs: 1_000,
        multipliers: [{ source: "weekend", permille: 2000 }],
      },
      {
        eventType: "reaction",
        nowOffsetMs: 2_000,
        multipliers: [{ source: "weekend", permille: 2000 }],
      },
      { eventType: "reaction", nowOffsetMs: 3_000 },
      { eventType: "message", nowOffsetMs: 4_000 },
    ],
  },
  {
    id: "unknown-and-disabled",
    description: "Unknown event types and switched-off rules award nothing and do not throw.",
    config: {
      curve: { kind: "quadratic", base: 100, maxLevel: 20 },
      rules: [
        { eventType: "message", minXp: 10, maxXp: 10, cooldownSeconds: 0 },
        { eventType: "sticker", minXp: 50, maxXp: 50, enabled: false },
      ],
    },
    initialTotalXp: 500,
    randomValues: [10],
    steps: [
      { eventType: "nonsense", nowOffsetMs: 0 },
      { eventType: "sticker", nowOffsetMs: 1_000 },
      { eventType: "message", nowOffsetMs: 2_000 },
    ],
  },
  {
    id: "penalty-and-level-loss",
    description: "Moderation deducts XP, the member drops a level, and the floor holds at zero.",
    config: {
      curve: { kind: "quadratic", base: 100, maxLevel: 20 },
      rules: [{ eventType: "message", minXp: 10, maxXp: 10 }],
    },
    initialTotalXp: 350,
    randomValues: [10],
    steps: [
      { kind: "penalize", amount: 100, nowOffsetMs: 0 },
      { kind: "penalize", amount: 1_000, nowOffsetMs: 1_000 },
    ],
  },
  {
    id: "decay-after-grace",
    description:
      "Decay charges whole periods after the grace window and stops at the floor.",
    config: {
      curve: { kind: "quadratic", base: 100, maxLevel: 20 },
      rules: [{ eventType: "message", minXp: 10, maxXp: 10, cooldownSeconds: 60 }],
      decay: {
        xpPerPeriod: 10,
        periodSeconds: 86400,
        floorXp: 900,
        graceSeconds: 604800,
      },
    },
    initialTotalXp: 1000,
    randomValues: [10],
    steps: [
      { eventType: "message", nowOffsetMs: 0 },
      { kind: "decay", nowOffsetMs: 3 * DAY },
      { kind: "decay", nowOffsetMs: 10 * DAY },
      { kind: "decay", nowOffsetMs: 11 * DAY },
      { kind: "decay", nowOffsetMs: 400 * DAY },
    ],
  },
];

write("awards", {
  formatVersion: FORMAT_VERSION,
  description:
    "End-to-end award sequences. Each scenario replays its steps against a FixedRandomSource seeded with randomValues, so no agreement about a pseudo-random algorithm is needed.",
  baseTimestampMs: T0,
  scenarios: awardScenarios.map((scenario) => {
    const engine = new RankEngine({
      curve: createCurve(scenario.config.curve),
      rules: (scenario.config.rules ?? []).map((rule) => createEventRule(rule)),
      globalCap: scenario.config.globalCap ?? null,
      decay: scenario.config.decay ?? null,
      allowNegative: scenario.config.allowNegative ?? false,
    });
    const random = new FixedRandomSource(scenario.randomValues);
    let state = createMemberState(scenario.initialTotalXp);

    const steps = scenario.steps.map((step) => {
      const now = T0 + step.nowOffsetMs;
      let result;
      if (step.kind === "penalize") {
        result = engine.penalize(state, step.amount, { now });
      } else if (step.kind === "decay") {
        result = engine.applyDecay(state, { now });
      } else {
        result = engine.award(state, step.eventType, {
          now,
          random,
          multipliers: step.multipliers ?? [],
        });
      }
      state = result.state;
      return {
        ...step,
        expected: {
          outcome: result.outcome,
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
        },
      };
    });

    return { ...scenario, steps, finalTotalXp: state.totalXp };
  }),
});

// --------------------------------------------------------------------------
// leaderboard
// --------------------------------------------------------------------------

const boardRows = [
  { memberId: "ana", totalXp: 500 },
  { memberId: "ben", totalXp: 900 },
  { memberId: "cai", totalXp: 500 },
  { memberId: "dee", totalXp: 100 },
  { memberId: "eli", totalXp: 900 },
  { memberId: "fay", totalXp: 0 },
  { memberId: "gus", totalXp: 12_345 },
];

const boardCurveSpec = { kind: "quadratic", base: 100, maxLevel: 50 };
const boardCurve = createCurve(boardCurveSpec);

write("leaderboard", {
  formatVersion: FORMAT_VERSION,
  description:
    "Tie handling is the part of a leaderboard everyone gets wrong. Ties keep the order the rows were handed in — never a comparison of member ids, which sorts differently in Python and JavaScript.",
  curve: boardCurveSpec,
  rows: boardRows,
  boards: [TieMode.Competition, TieMode.Dense, TieMode.Ordinal].map((tieMode) => ({
    tieMode,
    entries: buildLeaderboard(boardCurve, boardRows, { tieMode }).map((entry) => ({
      memberId: entry.memberId,
      totalXp: entry.totalXp,
      level: entry.level,
      rank: entry.rank,
      competitionRank: entry.competitionRank,
      denseRank: entry.denseRank,
      position: entry.position,
      progressPermille: entry.progress.progressPermille,
    })),
    rankOf: Object.fromEntries(
      boardRows.map((row) => [row.memberId, rankOf(row.memberId, boardRows, { tieMode })]),
    ),
  })),
  paging: {
    offset: 2,
    limit: 3,
    memberIds: buildLeaderboard(boardCurve, boardRows, { offset: 2, limit: 3 }).map(
      (entry) => entry.memberId,
    ),
  },
});

// --------------------------------------------------------------------------
// migration
// --------------------------------------------------------------------------

const migrationPairs = [
  {
    id: "linear-to-quadratic",
    from: { kind: "linear", base: 100, maxLevel: 30 },
    to: { kind: "quadratic", base: 100, maxLevel: 30 },
  },
  {
    id: "quadratic-to-exponential",
    from: { kind: "quadratic", base: 100, maxLevel: 30 },
    to: { kind: "exponential", base: 100, growthPermille: 1500, maxLevel: 30 },
  },
  {
    id: "quadratic-to-short-linear",
    from: { kind: "quadratic", base: 100, maxLevel: 30 },
    to: { kind: "linear", base: 100, maxLevel: 3 },
  },

  // ------------------------------------------------------------------------
  // The same curve, extended. This is the most ordinary curve change an
  // operator ever makes - "our community outgrew 20 levels" - and until 2.0.0
  // it handed every member sitting at the old top a free level: they report a
  // full bar, because there was no next level to be part-way to, and carrying a
  // full bar into a curve that does have one lands exactly on its threshold.
  //
  // No vector covered it. A property test found it.
  // ------------------------------------------------------------------------
  {
    id: "quadratic-extended",
    from: { kind: "quadratic", base: 100, maxLevel: 20 },
    to: { kind: "quadratic", base: 100, maxLevel: 50 },
  },
  {
    id: "linear-extended",
    from: { kind: "linear", base: 100, maxLevel: 5 },
    to: { kind: "linear", base: 100, maxLevel: 40 },
  },
  {
    id: "wide-to-wide",
    from: { kind: "tabular", thresholds: [0, 1000, 2000] },
    to: { kind: "tabular", thresholds: [0, 4503599627370496, 9007199254740991] },
  },
];

const migrationTotals = [
  0, 1, 99, 100, 350, 999, 1000, 5000, 50_000,
  // At and past the top of a 20-level quadratic curve (threshold 21000), which
  // is where the free level used to appear.
  20_999, 21_000, 21_001, 30_000, 100_000,
  // The magnitudes where the progress calculation itself used to diverge.
  1234, 4_503_599_627_370_496, 9_007_199_254_740_991,
];

write("migration", {
  formatVersion: FORMAT_VERSION,
  description:
    "Converting stored totals when the curve changes. A curve change is always a major version; these vectors pin down what it does to a member.",
  cases: migrationPairs.flatMap(({ id, from, to }) => {
    const fromCurve = createCurve(from);
    const toCurve = createCurve(to);
    return [
      MigrationStrategy.PreserveProgress,
      MigrationStrategy.PreserveLevel,
      MigrationStrategy.PreserveXp,
    ].map((strategy) => ({
      id: `${id}/${strategy}`,
      from,
      to,
      strategy,
      results: migrationTotals.map((totalXp) => {
        const result = migrateTotalXp(totalXp, fromCurve, toCurve, strategy);
        return {
          previousTotalXp: result.previousTotalXp,
          newTotalXp: result.newTotalXp,
          previousLevel: result.previousLevel,
          newLevel: result.newLevel,
          levelDelta: result.levelDelta,
          previousProgressPermille: result.previousProgressPermille,
          newProgressPermille: result.newProgressPermille,
          clampedToCurveTop: result.clampedToCurveTop,
        };
      }),
    }));
  }),
});

// --------------------------------------------------------------------------
// the ranked system
// --------------------------------------------------------------------------

const rating = (r, deviation, volatility = 60_000, matchesPlayed = 0) =>
  createRating({ rating: r, deviation, volatility, matchesPlayed });

const OUTCOMES = [MatchOutcome.Win, MatchOutcome.Loss, MatchOutcome.Draw];

const ratingProbes = [];
for (const player of [200, 800, 1200, 1500, 1800, 2400, 3200]) {
  for (const opponent of [200, 1000, 1500, 2200, 3200]) {
    for (const deviation of [30, 90, 175, 350]) {
      ratingProbes.push({
        player: { rating: player, deviation },
        opponent: { rating: opponent, deviation },
        expectedElo: expectedScorePermille(
          rating(player, deviation),
          rating(opponent, deviation),
          RatingSystem.Elo,
        ),
        expectedGlicko2: expectedScorePermille(
          rating(player, deviation),
          rating(opponent, deviation),
          RatingSystem.Glicko2,
        ),
      });
    }
  }
}

const eloCases = [];
for (const player of [0, 400, 1500, 2400, 3600, 5000]) {
  for (const opponent of [0, 1500, 2400, 5000]) {
    for (const matchesPlayed of [0, 9, 10, 100]) {
      for (const outcome of OUTCOMES) {
        const next = updateElo(
          rating(player, 200, 60_000, matchesPlayed),
          rating(opponent, 200),
          outcome,
        );
        eloCases.push({
          player: { rating: player, deviation: 200, matchesPlayed },
          opponent: { rating: opponent, deviation: 200 },
          outcome,
          result: {
            rating: next.rating,
            deviation: next.deviation,
            volatility: next.volatility,
            matchesPlayed: next.matchesPlayed,
          },
        });
      }
    }
  }
}

const glicko2Cases = [];
for (const player of [200, 1000, 1500, 2200, 3400]) {
  for (const opponent of [200, 1500, 3400]) {
    for (const deviation of [30, 120, 350]) {
      for (const volatility of [30_000, 60_000, 120_000]) {
        for (const outcome of OUTCOMES) {
          const next = updateGlicko2(rating(player, deviation, volatility, 25), [
            [rating(opponent, deviation), outcome],
          ]);
          glicko2Cases.push({
            player: { rating: player, deviation, volatility, matchesPlayed: 25 },
            results: [{ opponent: { rating: opponent, deviation }, outcome }],
            result: {
              rating: next.rating,
              deviation: next.deviation,
              volatility: next.volatility,
              matchesPlayed: next.matchesPlayed,
            },
          });
        }
      }
    }
  }
}

// Glickman's own worked example, and the rating period that has no matches in
// it -- the two cases every Glicko-2 implementation is judged on.
{
  const glickman = updateGlicko2(rating(1500, 200, 60_000, 0), [
    [rating(1400, 30), MatchOutcome.Win],
    [rating(1550, 100), MatchOutcome.Loss],
    [rating(1700, 300), MatchOutcome.Loss],
  ]);
  glicko2Cases.push({
    id: "glickman-worked-example",
    player: { rating: 1500, deviation: 200, volatility: 60_000, matchesPlayed: 0 },
    results: [
      { opponent: { rating: 1400, deviation: 30 }, outcome: MatchOutcome.Win },
      { opponent: { rating: 1550, deviation: 100 }, outcome: MatchOutcome.Loss },
      { opponent: { rating: 1700, deviation: 300 }, outcome: MatchOutcome.Loss },
    ],
    result: {
      rating: glickman.rating,
      deviation: glickman.deviation,
      volatility: glickman.volatility,
      matchesPlayed: glickman.matchesPlayed,
    },
  });

  for (const deviation of [40, 175, 350]) {
    const idle = updateGlicko2(rating(1500, deviation, 60_000, 30), []);
    glicko2Cases.push({
      id: `idle-period-rd${deviation}`,
      player: { rating: 1500, deviation, volatility: 60_000, matchesPlayed: 30 },
      results: [],
      result: {
        rating: idle.rating,
        deviation: idle.deviation,
        volatility: idle.volatility,
        matchesPlayed: idle.matchesPlayed,
      },
    });
  }
}

const intervalCases = [];
for (const deviation of [25, 60, 150, 350]) {
  for (const confidencePermille of [680, 900, 950, 990]) {
    const [low, high] = ratingInterval(rating(1500, deviation), confidencePermille);
    intervalCases.push({ deviation, confidencePermille, low, high });
  }
}

const defaultLadder = createLadderConfig();
const seedingCases = [];
for (let value = 0; value <= 4000; value += 29) {
  const position = positionForRating(value, defaultLadder);
  seedingCases.push({
    rating: value,
    tier: position.tier,
    division: position.division,
    leaguePoints: position.leaguePoints,
    formatted: formatPosition(position),
    roundTripRating: ratingForPosition(position, defaultLadder),
  });
}

const APEX = new Set([Tier.Master, Tier.Grandmaster, Tier.Challenger]);
const ladderCases = [];
for (const tier of Object.values(Tier)) {
  const divisions = APEX.has(tier)
    ? [null]
    : [Division.Four, Division.Three, Division.Two, Division.One];
  for (const division of divisions) {
    for (const leaguePoints of [0, 50, 99]) {
      const position = createLadderPosition({ tier, division, leaguePoints });
      for (const won of [true, false]) {
        for (const currentRating of [0, 1500, 3400]) {
          // 3 and 999 take the same branch -- demotion protection only asks
          // whether the count is below the threshold -- so two probes cover it.
          for (const matchesSincePromotion of [0, 3]) {
            const change = applyLeaguePoints(
              position,
              won,
              currentRating,
              defaultLadder,
              matchesSincePromotion,
            );
            ladderCases.push({
              from: { tier, division, leaguePoints },
              won,
              rating: currentRating,
              matchesSincePromotion,
              outcome: change.outcome,
              to: {
                tier: change.current.tier,
                division: change.current.division,
                leaguePoints: change.current.leaguePoints,
                series:
                  change.current.series === null
                    ? null
                    : {
                        winsNeeded: change.current.series.winsNeeded,
                        lossesAllowed: change.current.series.lossesAllowed,
                        wins: change.current.series.wins,
                        losses: change.current.series.losses,
                      },
              },
              pointsDelta: change.pointsDelta,
              tierChanged: change.tierChanged,
              seriesActive: change.seriesActive,
            });
          }
        }
      }
    }
  }
}

const seriesCases = [];
for (const wins of [0, 1, 2]) {
  for (const losses of [0, 1, 2]) {
    const position = createLadderPosition({
      tier: Tier.Gold,
      division: Division.One,
      leaguePoints: 100,
      series: createSeriesState({ winsNeeded: 3, lossesAllowed: 2, wins, losses }),
    });
    for (const won of [true, false]) {
      const change = applyLeaguePoints(position, won, 1500, defaultLadder, 999);
      seriesCases.push({
        series: { wins, losses },
        won,
        outcome: change.outcome,
        to: {
          tier: change.current.tier,
          division: change.current.division,
          leaguePoints: change.current.leaguePoints,
          series:
            change.current.series === null
              ? null
              : { wins: change.current.series.wins, losses: change.current.series.losses },
        },
        tierChanged: change.tierChanged,
        seriesActive: change.seriesActive,
      });
    }
  }
}

const resetCases = [];
for (const policy of [ResetPolicy.None, ResetPolicy.Soft, ResetPolicy.Hard]) {
  for (const pullPermille of [0, 250, 500, 750, 1000]) {
    for (const value of [0, 500, 1000, 1500, 2000, 2500, 3000, 4000]) {
      const next = resetRating(
        rating(value, 60, 75_000, 40),
        createSeasonResetConfig({ policy, pullPermille }),
      );
      resetCases.push({
        policy,
        pullPermille,
        from: { rating: value, deviation: 60, volatility: 75_000, matchesPlayed: 40 },
        to: {
          rating: next.rating,
          deviation: next.deviation,
          volatility: next.volatility,
          matchesPlayed: next.matchesPlayed,
        },
      });
    }
  }
}

const matchmakingCases = [];
for (const left of [800, 1500, 2200, 3000]) {
  for (const right of [800, 1500, 2200, 3000]) {
    for (const deviation of [30, 80, 175, 350]) {
      for (const system of [RatingSystem.Elo, RatingSystem.Glicko2]) {
        const quality = matchQuality(
          rating(left, deviation),
          rating(right, deviation),
          system,
        );
        matchmakingCases.push({
          left: { rating: left, deviation },
          right: { rating: right, deviation },
          system,
          qualityPermille: quality.qualityPermille,
          winProbabilityPermille: quality.winProbabilityPermille,
          ratingGap: quality.ratingGap,
          confident: quality.confident,
        });
      }
    }
  }
}

const teamCases = [];
for (const size of [1, 2, 3, 5, 8]) {
  const members = Array.from({ length: size }, (unused, index) => ({
    rating: 1200 + index * 137,
    deviation: 30 + index * 41,
    volatility: 50_000 + index * 7_000,
    matchesPlayed: index * 3,
  }));
  const combined = teamRating(members.map((m) => createRating(m)));
  teamCases.push({
    members,
    result: {
      rating: combined.rating,
      deviation: combined.deviation,
      volatility: combined.volatility,
      matchesPlayed: combined.matchesPlayed,
    },
  });
}

const balanceCases = [];
for (const size of [2, 4, 6, 8, 10]) {
  const players = Array.from({ length: size }, (unused, index) => ({
    rating: 1000 + ((index * 373) % 1700),
    deviation: 40 + ((index * 53) % 200),
    volatility: 60_000,
    matchesPlayed: 20,
  }));
  const split = balanceTeams(players.map((p) => createRating(p)));
  balanceCases.push({
    players,
    left: [...split.left],
    right: [...split.right],
    qualityPermille: split.quality.qualityPermille,
  });
}

// A whole season, match by match, in both rating systems. The single most
// valuable vector in the file: it is the only one that catches a divergence
// that only appears once a state has been carried through a hundred updates.
const rankedSeason = createSeason({
  id: "S1",
  name: "Season One",
  startsAt: 0,
  endsAt: 10_000_000,
});

const engineRuns = [];
for (const system of [RatingSystem.Elo, RatingSystem.Glicko2]) {
  for (const streakThreshold of [0, 3]) {
    const engine = new RankedEngine(
      createRankedConfig({
        system,
        season: rankedSeason,
        streakThreshold,
        placementMatches: 10,
      }),
    );
    let state = createRankedState();
    // MINSTD, written out so both editions step it identically. The multiplier
    // is small enough that the product stays inside JavaScript's safe-integer
    // range, which a textbook LCG constant would not.
    let seed = 12_345;
    const nextSeed = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed;
    };
    const matches = [];
    for (let index = 0; index < 120; index += 1) {
      const opponentRating = 900 + (nextSeed() % 1_800);
      const roll = nextSeed() % 100;
      const outcome =
        roll < 47 ? MatchOutcome.Win : roll < 94 ? MatchOutcome.Loss : MatchOutcome.Draw;
      const result = engine.recordMatch(
        state,
        rating(opponentRating, 80),
        outcome,
        index * 60_000,
      );
      state = result.state;
      const checkpoint = index % 20 === 19;
      matches.push({
        opponent: { rating: opponentRating, deviation: 80 },
        outcome,
        now: index * 60_000,
        ratingDelta: result.ratingDelta,
        inPlacements: result.inPlacements,
        placementsRemaining: result.placementsRemaining,
        expectedPermille: result.expectedPermille,
        streak: result.streak,
        rating: state.rating.rating,
        deviation: state.rating.deviation,
        volatility: state.rating.volatility,
        position:
          state.position === null
            ? null
            : {
                tier: state.position.tier,
                division: state.position.division,
                leaguePoints: state.position.leaguePoints,
              },
        ladder:
          result.ladder === null
            ? null
            : { outcome: result.ladder.outcome, pointsDelta: result.ladder.pointsDelta },
        // Every twentieth match carries the whole state, so a divergence that
        // appears late can be read off directly instead of replayed.
        state: checkpoint ? serializeRankedState(state) : null,
      });
    }
    const summary = engine.summarise(state);
    engineRuns.push({
      id: `${system}/streak-${streakThreshold}`,
      config: { system, streakThreshold, placementMatches: 10, seasonId: rankedSeason.id },
      matches,
      summary: {
        seasonId: summary.seasonId,
        matchesPlayed: summary.matchesPlayed,
        wins: summary.wins,
        losses: summary.losses,
        draws: summary.draws,
        peakRating: summary.peakRating,
        finalRating: summary.finalRating,
      },
      finalState: serializeRankedState(state),
    });
  }
}

write("ranked", {
  formatVersion: FORMAT_VERSION,
  description:
    "The competitive half of the library: expected scores, Elo and Glicko-2 updates, ladder brackets, promotion series, season resets, matchmaking and whole seasons played out match by match. Both editions must reproduce every number exactly.",
  expected: ratingProbes,
  elo: eloCases,
  glicko2: glicko2Cases,
  intervals: intervalCases,
  seeding: seedingCases,
  ladder: ladderCases,
  series: seriesCases,
  seasonResets: resetCases,
  matchmaking: matchmakingCases,
  teams: teamCases,
  balance: balanceCases,
  engine: engineRuns,
});

console.log(`\nAwardOutcome values in use: ${Object.values(AwardOutcome).join(", ")}`);
