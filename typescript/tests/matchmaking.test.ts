/**
 * Match quality and team balancing.
 *
 * These mirror `python/tests/test_matchmaking.py` test for test.
 */
import { describe, expect, it } from "vitest";

import {
  balanceTeams,
  createRating,
  DEFAULT_VOLATILITY,
  isAcceptable,
  matchQuality,
  type Rating,
  RatingSystem,
  teamRating,
  ValidationError,
} from "../src/index.js";

const R = (
  rating: number,
  deviation = 60,
  volatility = DEFAULT_VOLATILITY,
  matchesPlayed = 40,
): Rating => createRating({ rating, deviation, volatility, matchesPlayed });

const SYSTEMS = [RatingSystem.Elo, RatingSystem.Glicko2];

describe("matchQuality", () => {
  it("makes two equal certain players the best match there is", () => {
    const quality = matchQuality(R(1500, 30), R(1500, 30));
    expect(quality.winProbabilityPermille).toBe(500);
    expect(quality.ratingGap).toBe(0);
    expect(quality.confident).toBe(true);
    expect(quality.qualityPermille).toBeGreaterThan(700);
  });

  it("scores a foregone conclusion at nothing", () => {
    expect(matchQuality(R(500, 30), R(3500, 30)).qualityPermille).toBe(0);
  });

  it("falls faster than the gap grows", () => {
    // Deliberately not linear: an expected score of 550 is a good match, 650 is
    // mediocre and 750 is not worth playing. A linear scale would call the last
    // of those half quality, which would let a queue serve it.
    const qualities = [0, 100, 200, 400, 800].map(
      (gap) => matchQuality(R(1500, 30), R(1500 + gap, 30), RatingSystem.Elo).qualityPermille,
    );
    expect(qualities).toEqual([...qualities].sort((a, b) => b - a));
    expect(qualities[0]! - qualities[1]!).toBeLessThan(qualities[1]! - qualities[2]!);
  });

  it("gives the same answer whichever side is listed first", () => {
    // Glicko-2's expected score damps by the *opponent's* deviation, so the two
    // directions are two different calculations that agree to within a rounding
    // step — and the quality is quadratic in the imbalance, which turns one
    // permille into three. A queue that got a different verdict depending on
    // the order it held two players in would be a bug nobody could reproduce.
    for (const system of SYSTEMS) {
      for (const leftDeviation of [1, 7, 30, 175, 350]) {
        for (const rightDeviation of [1, 7, 30, 175, 350]) {
          for (const gap of [0, 41, 377, 1200]) {
            const left = matchQuality(R(0, leftDeviation), R(gap, rightDeviation), system);
            const right = matchQuality(R(gap, rightDeviation), R(0, leftDeviation), system);
            expect(left.qualityPermille).toBe(right.qualityPermille);
            expect(left.winProbabilityPermille + right.winProbabilityPermille).toBe(1000);
            expect(left.ratingGap).toBe(-right.ratingGap || 0);
          }
        }
      }
    }
  });

  it("signs the gap towards the first side", () => {
    expect(matchQuality(R(1800), R(1500)).ratingGap).toBe(300);
    expect(matchQuality(R(1500), R(1800)).ratingGap).toBe(-300);
  });

  it("discounts uncertainty under Glicko-2", () => {
    // A match that looks even between two unknowns is a guess, not a good
    // pairing, and the number has to say so.
    const certain = matchQuality(R(1500, 30), R(1500, 30), RatingSystem.Glicko2);
    const unknown = matchQuality(R(1500, 350), R(1500, 350), RatingSystem.Glicko2);
    expect(certain.qualityPermille).toBeGreaterThan(unknown.qualityPermille);
    expect(certain.confident).toBe(true);
    expect(unknown.confident).toBe(false);
  });

  it("gives Elo no opinion about uncertainty", () => {
    expect(matchQuality(R(1500, 30), R(1500, 30), RatingSystem.Elo).qualityPermille).toBe(
      matchQuality(R(1500, 350), R(1500, 350), RatingSystem.Elo).qualityPermille,
    );
  });

  it("asks about both sides for confidence", () => {
    expect(matchQuality(R(1500, 30), R(1500, 101)).confident).toBe(false);
    expect(matchQuality(R(1500, 101), R(1500, 30)).confident).toBe(false);
    expect(matchQuality(R(1500, 100), R(1500, 100)).confident).toBe(true);
  });

  it("stays inside 0 and 1000", () => {
    for (let left = 0; left <= 5000; left += 250) {
      for (let right = 0; right <= 5000; right += 250) {
        for (const deviation of [1, 30, 350]) {
          for (const system of SYSTEMS) {
            const quality = matchQuality(R(left, deviation), R(right, deviation), system);
            expect(quality.qualityPermille).toBeGreaterThanOrEqual(0);
            expect(quality.qualityPermille).toBeLessThanOrEqual(1000);
            expect(quality.winProbabilityPermille).toBeGreaterThanOrEqual(0);
            expect(quality.winProbabilityPermille).toBeLessThanOrEqual(1000);
          }
        }
      }
    }
  });
});

describe("isAcceptable", () => {
  it("passes a good match and rejects a bad one", () => {
    expect(isAcceptable(matchQuality(R(1500, 30), R(1500, 30)))).toBe(true);
    expect(isAcceptable(matchQuality(R(500, 30), R(3500, 30)))).toBe(false);
  });

  it("catches with the gap gate what the quality gate does not", () => {
    // A pairing between two players the system knows nothing about can score
    // acceptably on quality alone. The gap gate is what rejects it.
    const quality = matchQuality(R(1200, 350), R(1900, 350));
    expect(isAcceptable(quality, 0)).toBe(true);
    expect(isAcceptable(quality, 0, 300)).toBe(false);
  });

  it("relaxes as a queue widens", () => {
    const quality = matchQuality(R(1500, 30), R(1800, 30));
    expect(isAcceptable(quality, 900)).toBe(false);
    expect(isAcceptable(quality, 100)).toBe(true);
  });

  it("refuses an impossible threshold", () => {
    expect(() => isAcceptable(matchQuality(R(1500), R(1500)), -1)).toThrow(ValidationError);
    expect(() => isAcceptable(matchQuality(R(1500), R(1500)), 1001)).toThrow(ValidationError);
  });
});

describe("teamRating", () => {
  it("makes a team of one that player", () => {
    const team = teamRating([R(1700, 45, 62_000, 12)]);
    expect(team).toEqual(R(1700, 45, 62_000, 12));
  });

  it("takes the mean rating", () => {
    expect(teamRating([R(1000), R(2000)]).rating).toBe(1500);
    expect(teamRating([R(1000), R(1500), R(2000)]).rating).toBe(1500);
  });

  it("rounds the mean half away from zero", () => {
    expect(teamRating([R(1000), R(1001)]).rating).toBe(teamRating([R(1001), R(1000)]).rating);
  });

  it("combines deviations in quadrature rather than by averaging", () => {
    // Five uncertain players do not make an uncertain team: their errors partly
    // cancel, and the team is more predictable than any of them.
    expect(teamRating([R(1500, 100), R(1500, 100), R(1500, 100), R(1500, 100), R(1500, 100)]).deviation).toBe(
      100,
    );
    const mixed = teamRating([R(1500, 30), R(1500, 200)]);
    expect(mixed.deviation).toBeGreaterThan(30);
    expect(mixed.deviation).toBeLessThan(200);
    // Above the arithmetic mean of 115, which is the point.
    expect(mixed.deviation).toBeGreaterThan(115);
  });

  it("takes the least experienced member's match count", () => {
    // A team is as new as its newest member: that is what decides whether the
    // system should trust the pairing.
    expect(
      teamRating([R(1500, 60, DEFAULT_VOLATILITY, 3), R(1500, 60, DEFAULT_VOLATILITY, 500)])
        .matchesPlayed,
    ).toBe(3);
  });

  it("refuses an empty team", () => {
    expect(() => teamRating([])).toThrow(ValidationError);
  });

  it("never returns a zero deviation or volatility", () => {
    // Both are divisors elsewhere; a zero would be a crash far away from here.
    const team = teamRating([R(1500, 0, 1, 0), R(1500, 0, 1, 0)]);
    expect(team.deviation).toBeGreaterThanOrEqual(1);
    expect(team.volatility).toBeGreaterThanOrEqual(1);
  });
});

describe("balanceTeams", () => {
  it("splits two players one each", () => {
    const split = balanceTeams([R(1500), R(1600)]);
    expect([...split.left, ...split.right].sort()).toEqual([0, 1]);
    expect(split.left).toHaveLength(1);
    expect(split.right).toHaveLength(1);
  });

  it("always puts the first player on the left", () => {
    // Each split is considered once rather than twice with the sides swapped,
    // which halves the search and makes the answer stable.
    for (const size of [2, 4, 6, 8]) {
      const players = Array.from({ length: size }, (unused, index) => R(1000 + index * 100));
      expect(balanceTeams(players).left).toContain(0);
    }
  });

  it("uses every player exactly once", () => {
    for (const size of [2, 4, 6, 8, 10]) {
      const players = Array.from({ length: size }, (unused, index) =>
        R(1000 + ((index * 373) % 1700)),
      );
      const split = balanceTeams(players);
      expect([...split.left, ...split.right].sort((a, b) => a - b)).toEqual(
        Array.from({ length: size }, (unused, index) => index),
      );
      expect(split.left).toHaveLength(size / 2);
      expect(split.right).toHaveLength(size / 2);
    }
  });

  it("finds the even split rather than the obvious one", () => {
    // 1000, 1000, 2000, 2000 splits evenly only as {1000,2000} against
    // {1000,2000}. A greedy pairing would produce the lopsided one.
    const split = balanceTeams([R(1000, 30), R(1000, 30), R(2000, 30), R(2000, 30)]);
    expect([[0, 2], [0, 3]]).toContainEqual([...split.left]);
    expect(split.quality.ratingGap).toBe(0);
  });

  it("still splits an unbalanceable group", () => {
    const split = balanceTeams([R(500, 30), R(500, 30), R(500, 30), R(3500, 30)]);
    expect(split.left).toHaveLength(2);
    expect(split.quality.qualityPermille).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic", () => {
    const players = Array.from({ length: 8 }, (unused, index) =>
      R(1000 + ((index * 373) % 1700), 40 + index * 7),
    );
    const first = balanceTeams(players);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(balanceTeams(players)).toEqual(first);
    }
  });

  it("refuses an odd or empty group", () => {
    for (const count of [0, 1, 3, 7]) {
      const players = Array.from({ length: count }, () => R(1500));
      expect(() => balanceTeams(players)).toThrow(ValidationError);
    }
  });

  it("refuses more players than it will search", () => {
    // Exhaustive is the right algorithm at these sizes; above the cap a caller
    // is building something this function is not for.
    expect(() => balanceTeams(Array.from({ length: 22 }, () => R(1500)))).toThrow(ValidationError);
    expect(
      balanceTeams(Array.from({ length: 20 }, (unused, index) => R(1500 + index))).left,
    ).toHaveLength(10);
  });
});
