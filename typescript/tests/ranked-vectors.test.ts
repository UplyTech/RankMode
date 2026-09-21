/**
 * The contract between the two editions, for the ranked half.
 *
 * These vectors are generated from this edition and the Python one must
 * reproduce every last number. Running them here too is not redundant: it is
 * what catches a change to this edition that silently invalidates the file, so
 * that regenerating stays a deliberate act rather than something a developer
 * does to make a red build go green.
 *
 * The engine vectors are the valuable ones. Every other case is a single call
 * with a single answer; the engine cases replay a whole season match by match,
 * and they are the only thing in the suite that catches a divergence which
 * needs a hundred updates of accumulated state before it appears.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applyLeaguePoints,
  balanceTeams,
  createLadderConfig,
  createLadderPosition,
  createRankedConfig,
  createRankedState,
  createRating,
  createSeason,
  createSeasonResetConfig,
  createSeriesState,
  Division,
  expectedScorePermille,
  formatPosition,
  type LadderPosition,
  type MatchOutcome,
  matchQuality,
  positionForRating,
  RankedEngine,
  type Rating,
  ratingForPosition,
  ratingInterval,
  RatingSystem,
  type ResetPolicy,
  resetRating,
  serializeRankedState,
  teamRating,
  type Tier,
  updateElo,
  updateGlicko2,
} from "../src/index.js";

const vectorFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "shared",
  "testcases",
  "ranked.json",
);

const SUPPORTED_FORMAT_VERSION = 1;

/* eslint-disable @typescript-eslint/no-explicit-any */
const vectors: any = JSON.parse(readFileSync(vectorFile, "utf8"));
/* eslint-enable @typescript-eslint/no-explicit-any */

const ratingFrom = (raw: {
  rating: number;
  deviation: number;
  volatility?: number;
  matchesPlayed?: number;
}): Rating =>
  createRating({
    rating: raw.rating,
    deviation: raw.deviation,
    volatility: raw.volatility ?? 60_000,
    matchesPlayed: raw.matchesPlayed ?? 0,
  });

const positionFrom = (raw: {
  tier: string;
  division: number | null;
  leaguePoints: number;
  series?: {
    winsNeeded: number;
    lossesAllowed: number;
    wins: number;
    losses: number;
  } | null;
}): LadderPosition =>
  createLadderPosition({
    tier: raw.tier as Tier,
    division: raw.division === null ? null : (raw.division as Division),
    leaguePoints: raw.leaguePoints,
    series: raw.series ? createSeriesState(raw.series) : null,
  });

const ladder = createLadderConfig();

describe("the ranked vector file", () => {
  it("is present and complete", () => {
    expect(vectors.formatVersion).toBe(SUPPORTED_FORMAT_VERSION);
    for (const group of [
      "expected",
      "elo",
      "glicko2",
      "intervals",
      "seeding",
      "ladder",
      "series",
      "seasonResets",
      "matchmaking",
      "teams",
      "balance",
      "engine",
    ]) {
      expect(vectors[group].length).toBeGreaterThan(0);
    }
  });
});

describe("expected scores", () => {
  it("match the vectors", () => {
    for (const testCase of vectors.expected) {
      const player = ratingFrom(testCase.player);
      const opponent = ratingFrom(testCase.opponent);
      expect(expectedScorePermille(player, opponent, RatingSystem.Elo)).toBe(
        testCase.expectedElo,
      );
      expect(expectedScorePermille(player, opponent, RatingSystem.Glicko2)).toBe(
        testCase.expectedGlicko2,
      );
    }
  });
});

describe("rating updates", () => {
  it("match the Elo vectors", () => {
    for (const testCase of vectors.elo) {
      const got = updateElo(
        ratingFrom(testCase.player),
        ratingFrom(testCase.opponent),
        testCase.outcome as MatchOutcome,
      );
      expect(got).toEqual(ratingFrom(testCase.result));
    }
  });

  it("match the Glicko-2 vectors", () => {
    for (const testCase of vectors.glicko2) {
      const results = testCase.results.map(
        (entry: { opponent: { rating: number; deviation: number }; outcome: string }) =>
          [ratingFrom(entry.opponent), entry.outcome as MatchOutcome] as const,
      );
      const got = updateGlicko2(ratingFrom(testCase.player), results);
      expect(got, testCase.id ?? "").toEqual(ratingFrom(testCase.result));
    }
  });
});

describe("rating intervals", () => {
  it("match the vectors", () => {
    for (const testCase of vectors.intervals) {
      const [low, high] = ratingInterval(
        createRating({ rating: 1500, deviation: testCase.deviation }),
        testCase.confidencePermille,
      );
      expect([low, high]).toEqual([testCase.low, testCase.high]);
    }
  });
});

describe("ladder seeding", () => {
  it("matches the vectors", () => {
    for (const testCase of vectors.seeding) {
      const position = positionForRating(testCase.rating, ladder);
      expect(position.tier).toBe(testCase.tier);
      expect(position.division).toBe(testCase.division);
      expect(position.leaguePoints).toBe(testCase.leaguePoints);
      expect(formatPosition(position)).toBe(testCase.formatted);
      expect(ratingForPosition(position, ladder)).toBe(testCase.roundTripRating);
    }
  });
});

describe("ladder transitions", () => {
  it("match the vectors", () => {
    for (const testCase of vectors.ladder) {
      const change = applyLeaguePoints(
        positionFrom(testCase.from),
        testCase.won,
        testCase.rating,
        ladder,
        testCase.matchesSincePromotion,
      );
      expect(change.outcome).toBe(testCase.outcome);
      expect(change.current).toEqual(positionFrom(testCase.to));
      expect(change.pointsDelta).toBe(testCase.pointsDelta);
      expect(change.tierChanged).toBe(testCase.tierChanged);
      expect(change.seriesActive).toBe(testCase.seriesActive);
    }
  });

  it("match the promotion series vectors", () => {
    for (const testCase of vectors.series) {
      const position = createLadderPosition({
        tier: "GOLD" as Tier,
        division: Division.One,
        leaguePoints: 100,
        series: createSeriesState({
          winsNeeded: 3,
          lossesAllowed: 2,
          wins: testCase.series.wins,
          losses: testCase.series.losses,
        }),
      });
      const change = applyLeaguePoints(position, testCase.won, 1500, ladder, 999);
      expect(change.outcome).toBe(testCase.outcome);
      expect(change.current.tier).toBe(testCase.to.tier);
      expect(change.current.division).toBe(testCase.to.division);
      expect(change.current.leaguePoints).toBe(testCase.to.leaguePoints);
      if (testCase.to.series === null) {
        expect(change.current.series).toBeNull();
      } else {
        expect(change.current.series?.wins).toBe(testCase.to.series.wins);
        expect(change.current.series?.losses).toBe(testCase.to.series.losses);
      }
    }
  });
});

describe("season resets", () => {
  it("match the vectors", () => {
    for (const testCase of vectors.seasonResets) {
      const got = resetRating(
        ratingFrom(testCase.from),
        createSeasonResetConfig({
          policy: testCase.policy as ResetPolicy,
          pullPermille: testCase.pullPermille,
        }),
      );
      expect(got).toEqual(ratingFrom(testCase.to));
    }
  });
});

describe("matchmaking", () => {
  it("matches the quality vectors", () => {
    for (const testCase of vectors.matchmaking) {
      const quality = matchQuality(
        ratingFrom(testCase.left),
        ratingFrom(testCase.right),
        testCase.system as RatingSystem,
      );
      expect(quality.qualityPermille).toBe(testCase.qualityPermille);
      expect(quality.winProbabilityPermille).toBe(testCase.winProbabilityPermille);
      expect(quality.ratingGap).toBe(testCase.ratingGap);
      expect(quality.confident).toBe(testCase.confident);
    }
  });

  it("matches the team rating vectors", () => {
    for (const testCase of vectors.teams) {
      expect(teamRating(testCase.members.map(ratingFrom))).toEqual(ratingFrom(testCase.result));
    }
  });

  it("matches the balancing vectors", () => {
    for (const testCase of vectors.balance) {
      const split = balanceTeams(testCase.players.map(ratingFrom));
      expect([...split.left]).toEqual(testCase.left);
      expect([...split.right]).toEqual(testCase.right);
      expect(split.quality.qualityPermille).toBe(testCase.qualityPermille);
    }
  });
});

describe("whole seasons", () => {
  it("replay identically", () => {
    for (const run of vectors.engine) {
      const season = createSeason({
        id: run.config.seasonId,
        name: "Season One",
        startsAt: 0,
        endsAt: 10_000_000,
      });
      const engine = new RankedEngine(
        createRankedConfig({
          system: run.config.system as RatingSystem,
          season,
          streakThreshold: run.config.streakThreshold,
          placementMatches: run.config.placementMatches,
        }),
      );
      let state = createRankedState();

      run.matches.forEach((match: Record<string, unknown>, index: number) => {
        const result = engine.recordMatch(
          state,
          ratingFrom(match.opponent),
          match.outcome as MatchOutcome,
          match.now,
        );
        state = result.state;
        const where = `${run.id} match ${index}`;

        expect(result.ratingDelta, where).toBe(match.ratingDelta);
        expect(result.inPlacements, where).toBe(match.inPlacements);
        expect(result.placementsRemaining, where).toBe(match.placementsRemaining);
        expect(result.expectedPermille, where).toBe(match.expectedPermille);
        expect(result.streak, where).toBe(match.streak);
        expect(state.rating.rating, where).toBe(match.rating);
        expect(state.rating.deviation, where).toBe(match.deviation);
        expect(state.rating.volatility, where).toBe(match.volatility);

        if (match.position === null) {
          expect(state.position, where).toBeNull();
        } else {
          expect(state.position?.tier, where).toBe(match.position.tier);
          expect(state.position?.division, where).toBe(match.position.division);
          expect(state.position?.leaguePoints, where).toBe(match.position.leaguePoints);
        }

        if (match.ladder === null) {
          expect(result.ladder, where).toBeNull();
        } else {
          expect(result.ladder?.outcome, where).toBe(match.ladder.outcome);
          expect(result.ladder?.pointsDelta, where).toBe(match.ladder.pointsDelta);
        }

        if (match.state !== null) {
          expect(serializeRankedState(state), where).toEqual(match.state);
        }
      });

      const summary = engine.summarise(state);
      expect(summary.seasonId).toBe(run.summary.seasonId);
      expect(summary.matchesPlayed).toBe(run.summary.matchesPlayed);
      expect(summary.wins).toBe(run.summary.wins);
      expect(summary.losses).toBe(run.summary.losses);
      expect(summary.draws).toBe(run.summary.draws);
      expect(summary.peakRating).toBe(run.summary.peakRating);
      expect(summary.finalRating).toBe(run.summary.finalRating);
      expect(serializeRankedState(state)).toEqual(run.finalState);
    }
  });
});
