#!/usr/bin/env node
/**
 * Answer every generated case with the TypeScript edition.
 *
 * Run `npm run build` in typescript/ first - this reads the built package, so
 * what it answers for is what a caller would install rather than what the test
 * suite imports.
 *
 *   node run-typescript.mjs --cases cases.json --out results-typescript.json
 *
 * This file and run_python.py are deliberately written to mirror each other
 * line for line. A difference between them is a difference in the harness, not
 * in the library, and it is the one kind of false positive that would make
 * nobody trust the red build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, and the ESM loader reads `e:` as a URL scheme it does not know.
const {
  applyLeaguePoints,
  applyMultipliers,
  balanceTeams,
  buildLeaderboard,
  combinedPermille,
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
  deserializeMemberState,
  expectedScorePermille,
  FixedRandomSource,
  formatPosition,
  isAcceptable,
  matchQuality,
  migrateTotalXp,
  positionForRating,
  pruneMemberState,
  rankOf,
  RankEngine,
  RankedEngine,
  ratingForPosition,
  ratingInterval,
  resetRating,
  serializeMemberState,
  serializeRankedState,
  teamRating,
  updateElo,
  updateGlicko2,
} = await import(
  pathToFileURL(join(HERE, "..", "..", "..", "typescript", "dist", "index.mjs")).href
);

// ---------------------------------------------------------------------------
// Normalised shapes. Both runners emit exactly these keys, in this order.
// ---------------------------------------------------------------------------
const progressOf = (progress) => ({
  level: progress.level,
  totalXp: progress.totalXp,
  currentThreshold: progress.currentThreshold,
  nextThreshold: progress.nextThreshold,
  xpIntoLevel: progress.xpIntoLevel,
  xpToNext: progress.xpToNext,
  levelSpan: progress.levelSpan,
  progressPermille: progress.progressPermille,
  progressRatio: progress.progressRatio,
  isMaxLevel: progress.isMaxLevel,
});

const ratingOf = (value) => ({
  rating: value.rating,
  deviation: value.deviation,
  volatility: value.volatility,
  matchesPlayed: value.matchesPlayed,
});

const positionOf = (position) =>
  position === null
    ? null
    : {
        tier: position.tier,
        division: position.division,
        leaguePoints: position.leaguePoints,
        series:
          position.series === null
            ? null
            : {
                winsNeeded: position.series.winsNeeded,
                lossesAllowed: position.series.lossesAllowed,
                wins: position.series.wins,
                losses: position.series.losses,
              },
      };

const ratingFrom = (raw) =>
  createRating({
    rating: raw.rating,
    deviation: raw.deviation,
    volatility: raw.volatility,
    matchesPlayed: raw.matchesPlayed,
  });

const stateOf = (state) => ({
  totalXp: state.totalXp,
  lastEventAt: { ...state.lastEventAt },
  periodStartAt: { ...state.periodStartAt },
  periodAwardedXp: { ...state.periodAwardedXp },
  lastDecayAt: state.lastDecayAt,
});

const resultOf = (result) => ({
  outcome: result.outcome,
  changed: result.changed,
  awardedXp: result.awardedXp,
  baseXp: result.baseXp,
  multiplierPermille: result.multiplierPermille,
  previousTotalXp: result.previousTotalXp,
  newTotalXp: result.newTotalXp,
  previousLevel: result.previousLevel,
  newLevel: result.newLevel,
  leveledUp: result.leveledUp,
  leveledDown: result.leveledDown,
  progress: progressOf(result.progress),
  ruleEventType: result.rule === null ? null : result.rule.eventType,
  cooldownRemainingMs: result.cooldownRemainingMs,
  periodRemainingXp: result.periodRemainingXp,
  state: stateOf(result.state),
});

// ---------------------------------------------------------------------------
// One case, one answer. An error is an answer too: the two editions have to
// agree about what they refuse as well as about what they compute.
// ---------------------------------------------------------------------------
function answer(item) {
  switch (item.kind) {
    case "curve": {
      const curve = createCurve(item.spec);
      return {
        maxLevel: curve.maxLevel,
        thresholds: [...curve.thresholds],
        probes: item.probes.map((totalXp) => {
          try {
            return {
              totalXp,
              level: curve.levelForTotalXp(totalXp),
              progress: progressOf(curve.progressForTotalXp(totalXp)),
            };
          } catch (error) {
            return { totalXp, error: error.constructor.name };
          }
        }),
        xpForNextLevel: [0, 1, curve.maxLevel].map((level) => {
          try {
            return { level, value: curve.xpForNextLevel(level) };
          } catch (error) {
            return { level, error: error.constructor.name };
          }
        }),
      };
    }

    case "multipliers":
      return {
        applied: applyMultipliers(item.baseXp, item.chain),
        combined: combinedPermille(item.chain),
      };

    case "award": {
      const config = item.config;
      const engine = new RankEngine({
        curve: createCurve(config.curve),
        rules: config.rules.map((rule) => createEventRule(rule)),
        globalCap: config.globalCap,
        decay: config.decay,
        allowNegative: config.allowNegative,
        maxTotalXp: config.maxTotalXp,
      });

      const random = new FixedRandomSource(item.randomValues, { cycle: true });
      let state = createMemberState(item.initialTotalXp);
      const steps = [];

      for (const step of item.steps) {
        try {
          if (step.op === "award") {
            const result = engine.award(state, step.eventType, {
              now: step.now,
              multipliers: step.multipliers,
              random,
              ...(step.baseXp === null ? {} : { baseXp: step.baseXp }),
            });
            state = result.state;
            steps.push({ op: step.op, result: resultOf(result) });
          } else if (step.op === "penalize") {
            const result = engine.penalize(state, step.amount, {
              now: step.now,
              resetCooldownFor: step.resetCooldownFor,
            });
            state = result.state;
            steps.push({ op: step.op, result: resultOf(result) });
          } else if (step.op === "decay") {
            const result = engine.applyDecay(state, { now: step.now });
            state = result.state;
            steps.push({ op: step.op, result: resultOf(result) });
          } else {
            state = pruneMemberState(state, {
              now: step.now,
              keepCooldownMs: step.keepCooldownMs,
            });
            steps.push({ op: step.op, state: stateOf(state) });
          }
        } catch (error) {
          steps.push({ op: step.op, error: error.constructor.name });
        }
      }

      return { steps, finalState: stateOf(state) };
    }

    case "leaderboard": {
      const curve = createCurve(item.spec);
      const board = buildLeaderboard(curve, item.rows, {
        tieMode: item.tieMode,
        offset: item.offset,
        ...(item.limit === null ? {} : { limit: item.limit }),
      });
      return {
        entries: board.map((entry) => ({
          memberId: entry.memberId,
          totalXp: entry.totalXp,
          level: entry.level,
          rank: entry.rank,
          competitionRank: entry.competitionRank,
          denseRank: entry.denseRank,
          position: entry.position,
          progressPermille: entry.progress.progressPermille,
        })),
        ranks: item.rows.map((row) => rankOf(row.memberId, item.rows, { tieMode: item.tieMode })),
      };
    }

    case "migration": {
      const from = createCurve(item.from);
      const to = createCurve(item.to);
      return {
        results: item.totals.map((totalXp) => {
          try {
            const result = migrateTotalXp(totalXp, from, to, item.strategy);
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
          } catch (error) {
            return { totalXp, error: error.constructor.name };
          }
        }),
      };
    }

    case "state": {
      const restored = deserializeMemberState(item.state);
      const pruned = pruneMemberState(restored, {
        now: item.pruneNow,
        keepCooldownMs: item.keepCooldownMs,
      });
      return {
        roundTrip: serializeMemberState(restored),
        pruned: stateOf(pruned),
      };
    }

    case "rating": {
      const player = ratingFrom(item.player);
      const opponent = ratingFrom(item.opponent);
      const period = item.results.map((entry) => [ratingFrom(entry.opponent), entry.outcome]);
      return {
        expectedElo: expectedScorePermille(player, opponent, "ELO"),
        expectedGlicko2: expectedScorePermille(player, opponent, "GLICKO2"),
        elo: ratingOf(updateElo(player, opponent, item.outcome)),
        glicko2Single: ratingOf(updateGlicko2(player, [[opponent, item.outcome]])),
        glicko2Period: ratingOf(updateGlicko2(player, period)),
        interval: [...ratingInterval(player, item.confidencePermille)],
      };
    }

    case "ladder": {
      const config = createLadderConfig(item.config);
      const position = createLadderPosition({
        tier: item.from.tier,
        division: item.from.division,
        leaguePoints: item.from.leaguePoints,
        series: item.from.series === null ? null : createSeriesState(item.from.series),
      });
      const change = applyLeaguePoints(
        position,
        item.won,
        item.rating,
        config,
        item.matchesSincePromotion,
      );
      return {
        outcome: change.outcome,
        current: positionOf(change.current),
        pointsDelta: change.pointsDelta,
        tierChanged: change.tierChanged,
        seriesActive: change.seriesActive,
        formatted: formatPosition(change.current),
        ratingForPosition: ratingForPosition(position, config),
        seeded: item.seedProbes.map((probe) => positionOf(positionForRating(probe, config))),
        reset: ratingOf(
          resetRating(
            createRating({
              rating: item.rating,
              deviation: 60,
              volatility: 60_000,
              matchesPlayed: 40,
            }),
            createSeasonResetConfig({
              policy: item.reset.policy,
              pullPermille: item.reset.pullPermille,
              meanRating: item.reset.meanRating,
            }),
          ),
        ),
      };
    }

    case "ranked": {
      const engine = new RankedEngine(
        createRankedConfig({
          system: item.system,
          season: item.withSeason
            ? createSeason({ id: "S1", name: "One", startsAt: 0, endsAt: 10_000_000_000 })
            : null,
          placementMatches: item.placementMatches,
          streakThreshold: item.streakThreshold,
          streakBonusPoints: item.streakBonusPoints,
          maxStreakBonus: item.maxStreakBonus,
        }),
      );
      let state = createRankedState(ratingFrom(item.start));
      const steps = item.matches.map((match, index) => {
        const result = engine.recordMatch(
          state,
          ratingFrom(match.opponent),
          match.outcome,
          index * 60_000,
        );
        state = result.state;
        return {
          ratingDelta: result.ratingDelta,
          inPlacements: result.inPlacements,
          placementsRemaining: result.placementsRemaining,
          expectedPermille: result.expectedPermille,
          streak: result.streak,
          ladder:
            result.ladder === null
              ? null
              : { outcome: result.ladder.outcome, pointsDelta: result.ladder.pointsDelta },
        };
      });
      const summary = engine.summarise(state);
      return {
        steps,
        finalState: serializeRankedState(state),
        summary: {
          seasonId: summary.seasonId,
          matchesPlayed: summary.matchesPlayed,
          wins: summary.wins,
          losses: summary.losses,
          draws: summary.draws,
          peakRating: summary.peakRating,
          finalRating: summary.finalRating,
          peakPosition: positionOf(summary.peakPosition),
          finalPosition: positionOf(summary.finalPosition),
        },
      };
    }

    case "matchmaking": {
      const left = ratingFrom(item.left);
      const right = ratingFrom(item.right);
      const quality = matchQuality(left, right, item.system);
      const reversed = matchQuality(right, left, item.system);
      const players = item.players.map(ratingFrom);
      const split = balanceTeams(players, item.system);
      return {
        qualityPermille: quality.qualityPermille,
        winProbabilityPermille: quality.winProbabilityPermille,
        ratingGap: quality.ratingGap,
        confident: quality.confident,
        // The reversed call is answered too: it is the property that used to
        // fail, and a harness that only asked one way round would not see it.
        reversedQualityPermille: reversed.qualityPermille,
        acceptable: isAcceptable(quality, item.minimumQualityPermille, item.maximumGap),
        team: ratingOf(teamRating(players)),
        left: [...split.left],
        right: [...split.right],
        splitQualityPermille: split.quality.qualityPermille,
      };
    }

    default:
      throw new Error(`unknown case kind: ${item.kind}`);
  }
}

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };

  const input = JSON.parse(readFileSync(flag("cases", join(HERE, "cases.json")), "utf8"));
  const out = flag("out", join(HERE, "results-typescript.json"));

  const results = input.cases.map((item) => {
    try {
      return { id: item.id, kind: item.kind, value: answer(item) };
    } catch (error) {
      return { id: item.id, kind: item.kind, error: error.constructor.name };
    }
  });

  writeFileSync(
    out,
    `${JSON.stringify({ formatVersion: input.formatVersion, seed: input.seed, edition: "typescript", results })}\n`,
    "utf8",
  );
  console.log(`typescript answered ${results.length} cases -> ${out}`);
}

main();
