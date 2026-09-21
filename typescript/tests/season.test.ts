/**
 * Seasons, resets and summaries.
 *
 * These mirror `python/tests/test_season.py` test for test.
 */
import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  createRating,
  createSeason,
  createSeasonResetConfig,
  DEFAULT_VOLATILITY,
  Division,
  isWithin,
  type Rating,
  type Season,
  type SeasonSummary,
  SeasonError,
  ResetPolicy,
  resetPosition,
  resetRating,
  seasonFor,
  Tier,
  ValidationError,
  winRatePermille,
  createLadderPosition,
} from "../src/index.js";

const DAY = 86_400_000;

const R = (rating: number, deviation = 60, volatility = DEFAULT_VOLATILITY, matchesPlayed = 40): Rating =>
  createRating({ rating, deviation, volatility, matchesPlayed });

describe("createSeason", () => {
  it("contains its own range", () => {
    const season = createSeason({ id: "S1", name: "One", startsAt: 0, endsAt: 100 * DAY });
    expect(isWithin(season, 0)).toBe(true);
    expect(isWithin(season, 50 * DAY)).toBe(true);
    expect(isWithin(season, 100 * DAY - 1)).toBe(true);
  });

  it("makes the end exclusive so two seasons can meet", () => {
    const first = createSeason({ id: "S1", name: "One", startsAt: 0, endsAt: 100 * DAY });
    const second = createSeason({ id: "S2", name: "Two", startsAt: 100 * DAY, endsAt: 200 * DAY });
    expect(isWithin(first, 100 * DAY)).toBe(false);
    expect(isWithin(second, 100 * DAY)).toBe(true);
  });

  it("runs for ever when open-ended", () => {
    const season = createSeason({ id: "S1", name: "One", startsAt: 0 });
    expect(isWithin(season, 10 ** 15)).toBe(true);
    expect(isWithin(season, -1)).toBe(false);
  });

  it("refuses an empty id", () => {
    expect(() => createSeason({ id: "", name: "One", startsAt: 0 })).toThrow(ConfigurationError);
  });

  it("refuses non-integer timestamps", () => {
    expect(() => createSeason({ id: "S1", name: "One", startsAt: 1.5 })).toThrow(
      ConfigurationError,
    );
    expect(() => createSeason({ id: "S1", name: "One", startsAt: 0, endsAt: 1.5 })).toThrow(
      ConfigurationError,
    );
  });

  it("refuses a season that ends before it begins", () => {
    expect(() => createSeason({ id: "S1", name: "One", startsAt: 100, endsAt: 100 })).toThrow(
      SeasonError,
    );
    expect(() => createSeason({ id: "S1", name: "One", startsAt: 100, endsAt: 50 })).toThrow(
      SeasonError,
    );
  });
});

describe("seasonFor", () => {
  const SEASONS: Season[] = [
    createSeason({ id: "S1", name: "One", startsAt: 0, endsAt: 100 * DAY }),
    // A deliberate gap: the week where last season is over and the next has not
    // begun. Normal, and not an error.
    createSeason({ id: "S2", name: "Two", startsAt: 107 * DAY, endsAt: 200 * DAY }),
    createSeason({ id: "S3", name: "Three", startsAt: 200 * DAY }),
  ];

  it("finds the season a timestamp falls in", () => {
    expect(seasonFor(SEASONS, 50 * DAY)?.id).toBe("S1");
    expect(seasonFor(SEASONS, 150 * DAY)?.id).toBe("S2");
    expect(seasonFor(SEASONS, 10 ** 15)?.id).toBe("S3");
  });

  it("returns null in a gap rather than throwing", () => {
    expect(seasonFor(SEASONS, 103 * DAY)).toBeNull();
    expect(seasonFor(SEASONS, -1)).toBeNull();
    expect(seasonFor([], 0)).toBeNull();
  });

  it("refuses a non-integer timestamp", () => {
    expect(() => seasonFor(SEASONS, 1.5)).toThrow(ValidationError);
  });
});

describe("createSeasonResetConfig", () => {
  it("refuses impossible configuration", () => {
    expect(() => createSeasonResetConfig({ pullPermille: -1 })).toThrow(ConfigurationError);
    expect(() => createSeasonResetConfig({ pullPermille: 1001 })).toThrow(ConfigurationError);
    expect(() => createSeasonResetConfig({ resetDeviation: 0 })).toThrow(ConfigurationError);
  });

  it("describes a soft reset by default", () => {
    const config = createSeasonResetConfig();
    expect(config.policy).toBe(ResetPolicy.Soft);
    expect(config.pullPermille).toBe(500);
    expect(config.resetDeviation).toBe(175);
    expect(config.keepVolatility).toBe(true);
  });
});

describe("resetRating", () => {
  it("changes nothing under None", () => {
    const before = R(2400, 45, 71_000, 93);
    expect(resetRating(before, createSeasonResetConfig({ policy: ResetPolicy.None }))).toEqual(
      before,
    );
  });

  it("returns everybody to the start under Hard", () => {
    const after = resetRating(R(2400), createSeasonResetConfig({ policy: ResetPolicy.Hard }));
    expect(after.rating).toBe(1500);
    expect(after.deviation).toBe(350);
    expect(after.matchesPlayed).toBe(0);
  });

  it("pulls halfway to the mean under Soft", () => {
    expect(resetRating(R(2500), createSeasonResetConfig()).rating).toBe(2000);
    expect(resetRating(R(500), createSeasonResetConfig()).rating).toBe(1000);
    expect(resetRating(R(1500), createSeasonResetConfig()).rating).toBe(1500);
  });

  it("keeps the rating at a pull of zero and hard-resets it at a thousand", () => {
    expect(resetRating(R(2400), createSeasonResetConfig({ pullPermille: 0 })).rating).toBe(2400);
    expect(resetRating(R(2400), createSeasonResetConfig({ pullPermille: 1000 })).rating).toBe(1500);
  });

  it("is symmetric about the mean", () => {
    // A player above the mean and one equally far below must move by the same
    // amount, or the reset drifts the population.
    for (let distance = 0; distance <= 2000; distance += 37) {
      const up = resetRating(R(1500 + distance), createSeasonResetConfig()).rating - 1500;
      const down = 1500 - resetRating(R(1500 - distance), createSeasonResetConfig()).rating;
      expect(up).toBe(down);
    }
  });

  it("widens the deviation so the first matches count for more", () => {
    const after = resetRating(R(2000, 40), createSeasonResetConfig());
    expect(after.deviation).toBe(175);
  });

  it("keeps the volatility by default and can be asked not to", () => {
    // A player whose results were erratic last season is likely to be erratic
    // this season, and that is information worth keeping.
    expect(resetRating(R(2000, 60, 98_000), createSeasonResetConfig()).volatility).toBe(98_000);
    expect(
      resetRating(R(2000, 60, 98_000), createSeasonResetConfig({ keepVolatility: false }))
        .volatility,
    ).toBe(DEFAULT_VOLATILITY);
  });

  it("resets the match count so placements happen again", () => {
    expect(resetRating(R(2000, 60, DEFAULT_VOLATILITY, 250), createSeasonResetConfig()).matchesPlayed).toBe(0);
    expect(
      resetRating(
        R(2000, 60, DEFAULT_VOLATILITY, 250),
        createSeasonResetConfig({ resetMatchesPlayed: false }),
      ).matchesPlayed,
    ).toBe(250);
  });

  it("compresses the population without reordering it", () => {
    const reset: number[] = [];
    for (let rating = 0; rating <= 4000; rating += 50) {
      reset.push(resetRating(R(rating), createSeasonResetConfig()).rating);
    }
    expect(reset).toEqual([...reset].sort((a, b) => a - b));
  });

  it("moves towards a custom mean", () => {
    expect(resetRating(R(2500), createSeasonResetConfig({ meanRating: 2000 })).rating).toBe(2250);
  });
});

describe("resetPosition", () => {
  it("derives the bracket from the reset rating", () => {
    // Not carried over from last season: the bracket is a display of the
    // rating, and the rating just moved.
    expect(resetPosition(R(2900)).tier).toBe(Tier.Diamond); // 2900 pulled halfway is 2200
  });

  it("leaves the player where they were under a None policy", () => {
    expect(
      resetPosition(R(2900), createSeasonResetConfig({ policy: ResetPolicy.None })).tier,
    ).toBe(Tier.Challenger);
  });
});

describe("winRatePermille", () => {
  const summary = (wins: number, losses: number, draws: number): SeasonSummary => ({
    seasonId: "S1",
    matchesPlayed: wins + losses + draws,
    wins,
    losses,
    draws,
    peakRating: 1800,
    finalRating: 1700,
    peakPosition: null,
    finalPosition: null,
  });

  it("excludes draws from the denominator", () => {
    // A win rate is read as "how often do I win when it is decided". With draws
    // in the denominator a ladder with many of them shows everybody at 500.
    expect(winRatePermille(summary(40, 20, 40))).toBe(666);
  });

  it("is zero for a player who never finished a match", () => {
    expect(winRatePermille(summary(0, 0, 3))).toBe(0);
  });

  it("carries the peak separately from the final standing", () => {
    // Rewards are based on the peak: a player who reached Diamond in March and
    // slipped to Platinum in May earned the Diamond reward.
    const withPositions: SeasonSummary = {
      ...summary(110, 90, 0),
      peakRating: 2200,
      finalRating: 1950,
      peakPosition: createLadderPosition({
        tier: Tier.Diamond,
        division: Division.One,
        leaguePoints: 50,
      }),
      finalPosition: createLadderPosition({
        tier: Tier.Platinum,
        division: Division.Two,
        leaguePoints: 20,
      }),
    };
    expect(withPositions.peakPosition?.tier).toBe(Tier.Diamond);
    expect(withPositions.finalPosition?.tier).toBe(Tier.Platinum);
    expect(withPositions.peakRating).toBeGreaterThan(withPositions.finalRating);
  });
});
