/**
 * Elo and Glicko-2.
 *
 * The reference for the Glicko-2 numbers is Glickman's own paper, "Example of
 * the Glicko-2 system", which works one rating period through by hand and
 * prints the answers. An implementation that does not reproduce it is wrong,
 * however plausible its numbers look, so that example is a test rather than a
 * comment.
 *
 * These mirror `python/tests/test_rating.py` test for test.
 */
import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  createEloConfig,
  createGlicko2Config,
  createRating,
  DEFAULT_DEVIATION,
  DEFAULT_RATING,
  DEFAULT_VOLATILITY,
  expectedScorePermille,
  kFor,
  MatchOutcome,
  type Rating,
  ratingInterval,
  RatingSystem,
  scorePermille,
  updateElo,
  updateGlicko2,
  ValidationError,
} from "../src/index.js";

const R = (
  rating: number,
  deviation: number,
  volatility = DEFAULT_VOLATILITY,
  matchesPlayed = 0,
): Rating => createRating({ rating, deviation, volatility, matchesPlayed });

const OUTCOMES = [MatchOutcome.Win, MatchOutcome.Loss, MatchOutcome.Draw];
const SYSTEMS = [RatingSystem.Elo, RatingSystem.Glicko2];

describe("MatchOutcome", () => {
  it("scores", () => {
    expect(scorePermille(MatchOutcome.Win)).toBe(1000);
    expect(scorePermille(MatchOutcome.Loss)).toBe(0);
    expect(scorePermille(MatchOutcome.Draw)).toBe(500);
  });
});

describe("createRating", () => {
  it("describes a newcomer by default", () => {
    const rating = createRating();
    expect(rating.rating).toBe(DEFAULT_RATING);
    expect(rating.deviation).toBe(DEFAULT_DEVIATION);
    expect(rating.volatility).toBe(DEFAULT_VOLATILITY);
    expect(rating.matchesPlayed).toBe(0);
  });

  it("refuses non-integers", () => {
    expect(() => createRating({ rating: 1.5 })).toThrow(ValidationError);
    expect(() => createRating({ deviation: Number.NaN })).toThrow(ValidationError);
    expect(() => createRating({ volatility: Number.POSITIVE_INFINITY })).toThrow(
      ValidationError,
    );
  });

  it("refuses impossible values", () => {
    expect(() => createRating({ deviation: -1 })).toThrow(ValidationError);
    expect(() => createRating({ volatility: 0 })).toThrow(ValidationError);
    expect(() => createRating({ matchesPlayed: -1 })).toThrow(ValidationError);
  });
});

describe("expectedScorePermille", () => {
  it("makes equal players a coin toss", () => {
    for (const system of SYSTEMS) {
      expect(expectedScorePermille(R(1500, 50), R(1500, 50), system)).toBe(500);
    }
  });

  it("puts 400 points at ten to one under Elo", () => {
    // The definition of the Elo scale: 400 points is a factor of ten in odds.
    const got = expectedScorePermille(R(1500, 50), R(1900, 50), RatingSystem.Elo);
    expect(Math.abs(got - Math.floor(1000 / 11))).toBeLessThanOrEqual(1);
  });

  it("is symmetric", () => {
    for (const system of SYSTEMS) {
      for (const gap of [0, 50, 200, 400, 800]) {
        const forward = expectedScorePermille(R(1500, 60), R(1500 + gap, 60), system);
        const backward = expectedScorePermille(R(1500 + gap, 60), R(1500, 60), system);
        expect(forward + backward).toBe(1000);
      }
    }
  });

  it("rises with the player's rating", () => {
    for (const system of SYSTEMS) {
      let previous = -1;
      for (let rating = 0; rating <= 4000; rating += 50) {
        const current = expectedScorePermille(R(rating, 60), R(2000, 60), system);
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    }
  });

  it("lets an uncertain opponent pull Glicko-2 towards a coin toss", () => {
    // The difference between the two systems, stated as a test: Elo sees only
    // the ratings, Glicko-2 also sees how much they can be trusted.
    const certain = expectedScorePermille(R(1500, 30), R(1900, 30), RatingSystem.Glicko2);
    const uncertain = expectedScorePermille(R(1500, 30), R(1900, 350), RatingSystem.Glicko2);
    expect(uncertain).toBeGreaterThan(certain);
    expect(expectedScorePermille(R(1500, 30), R(1900, 30), RatingSystem.Elo)).toBe(
      expectedScorePermille(R(1500, 30), R(1900, 350), RatingSystem.Elo),
    );
  });

  it("stays inside 0 and 1000 at the extremes", () => {
    for (const system of SYSTEMS) {
      expect(expectedScorePermille(R(0, 30), R(5000, 30), system)).toBe(0);
      expect(expectedScorePermille(R(5000, 30), R(0, 30), system)).toBe(1000);
    }
  });
});

describe("the Elo K schedule", () => {
  it("falls as a player settles", () => {
    const config = createEloConfig();
    expect(kFor(R(1500, 350, DEFAULT_VOLATILITY, 0), config)).toBe(40);
    expect(kFor(R(1500, 350, DEFAULT_VOLATILITY, 9), config)).toBe(40);
    expect(kFor(R(1500, 60, DEFAULT_VOLATILITY, 10), config)).toBe(20);
    expect(kFor(R(2400, 60, DEFAULT_VOLATILITY, 100), config)).toBe(10);
  });

  it("refuses impossible configuration", () => {
    expect(() => createEloConfig({ placementK: 0 })).toThrow(ConfigurationError);
    expect(() => createEloConfig({ standardK: -1 })).toThrow(ConfigurationError);
    expect(() => createEloConfig({ placementMatches: -1 })).toThrow(ConfigurationError);
    expect(() => createEloConfig({ floor: 100, ceiling: 50 })).toThrow(ConfigurationError);
  });
});

describe("updateElo", () => {
  it("gains half of K for a win against an equal", () => {
    const after = updateElo(R(1500, 60, DEFAULT_VOLATILITY, 50), R(1500, 60), MatchOutcome.Win);
    expect(after.rating).toBe(1510);
    expect(after.matchesPlayed).toBe(51);
  });

  it("costs half of K for a loss against an equal", () => {
    expect(
      updateElo(R(1500, 60, DEFAULT_VOLATILITY, 50), R(1500, 60), MatchOutcome.Loss).rating,
    ).toBe(1490);
  });

  it("leaves a draw between equals where it was", () => {
    const after = updateElo(R(1500, 60, DEFAULT_VOLATILITY, 50), R(1500, 60), MatchOutcome.Draw);
    expect(after.rating).toBe(1500);
    expect(after.matchesPlayed).toBe(51);
  });

  it("pays more for beating a stronger player", () => {
    const weak = updateElo(R(1500, 60, DEFAULT_VOLATILITY, 50), R(1900, 60), MatchOutcome.Win);
    const even = updateElo(R(1500, 60, DEFAULT_VOLATILITY, 50), R(1500, 60), MatchOutcome.Win);
    expect(weak.rating).toBeGreaterThan(even.rating);
  });

  it("moves a newcomer faster than a veteran", () => {
    const newcomer = updateElo(R(1500, 350, DEFAULT_VOLATILITY, 0), R(1500, 60), MatchOutcome.Win);
    const veteran = updateElo(R(1500, 60, DEFAULT_VOLATILITY, 200), R(1500, 60), MatchOutcome.Win);
    expect(newcomer.rating - 1500).toBeGreaterThan(veteran.rating - 1500);
  });

  it("keeps gains and losses symmetric", () => {
    for (let opponent = 0; opponent <= 3600; opponent += 200) {
      const gain =
        updateElo(R(1500, 60, DEFAULT_VOLATILITY, 50), R(opponent, 60), MatchOutcome.Win).rating -
        1500;
      const loss =
        1500 -
        updateElo(R(1500, 60, DEFAULT_VOLATILITY, 50), R(opponent, 60), MatchOutcome.Loss).rating;
      // A win against X and a loss to X must add up to K, or the ladder leaks
      // or mints rating over time.
      expect(gain + loss).toBe(20);
    }
  });

  it("respects the floor and the ceiling", () => {
    const config = createEloConfig({ floor: 1000, ceiling: 2000 });
    expect(
      updateElo(R(1000, 60, DEFAULT_VOLATILITY, 50), R(3000, 60), MatchOutcome.Loss, config).rating,
    ).toBe(1000);
    expect(
      updateElo(R(2000, 60, DEFAULT_VOLATILITY, 50), R(0, 60), MatchOutcome.Win, config).rating,
    ).toBe(2000);
  });

  it("leaves deviation and volatility alone", () => {
    // Elo has no opinion about either; pretending otherwise would make a state
    // that switched systems mid-season nonsense.
    const after = updateElo(R(1500, 123, 77_000, 50), R(1500, 60), MatchOutcome.Win);
    expect(after.deviation).toBe(123);
    expect(after.volatility).toBe(77_000);
  });
});

describe("Glicko-2 configuration", () => {
  it("refuses impossible configuration", () => {
    expect(() => createGlicko2Config({ tau: 0 })).toThrow(ConfigurationError);
    expect(() => createGlicko2Config({ minDeviation: 0 })).toThrow(ConfigurationError);
    expect(() => createGlicko2Config({ minDeviation: 400, maxDeviation: 350 })).toThrow(
      ConfigurationError,
    );
    expect(() => createGlicko2Config({ minVolatility: 0 })).toThrow(ConfigurationError);
    expect(() => createGlicko2Config({ minVolatility: 600_000, maxVolatility: 500_000 })).toThrow(
      ConfigurationError,
    );
  });
});

describe("updateGlicko2", () => {
  it("reproduces Glickman's worked example", () => {
    // The paper starts a player at 1500/200/0.06, plays them against 1400,
    // 1550 and 1700 with results 1, 0, 0, and gets 1464.06, 151.52, 0.05999.
    const after = updateGlicko2(R(1500, 200, 60_000, 0), [
      [R(1400, 30), MatchOutcome.Win],
      [R(1550, 100), MatchOutcome.Loss],
      [R(1700, 300), MatchOutcome.Loss],
    ]);
    expect(after.rating).toBe(1464);
    expect(after.deviation).toBe(152);
    expect(after.volatility).toBe(59_996);
    expect(after.matchesPlayed).toBe(3);
  });

  it("widens the deviation for an idle period and moves nothing else", () => {
    const before = R(1500, 60, 60_000, 40);
    const after = updateGlicko2(before, []);
    expect(after.rating).toBe(before.rating);
    expect(after.deviation).toBeGreaterThan(before.deviation);
    expect(after.volatility).toBe(before.volatility);
    expect(after.matchesPlayed).toBe(before.matchesPlayed);
  });

  it("climbs all the way to the cap over repeated idle periods", () => {
    // The regression test for the fixed point the decay used to have. Past 109
    // one period's growth rounded back to the number it started from, so an
    // idle player climbed for forty-nine periods and then stopped for ever.
    let rating = R(1500, 60, 60_000, 40);
    for (let index = 0; index < 500; index += 1) {
      rating = updateGlicko2(rating, []);
    }
    expect(rating.deviation).toBe(createGlicko2Config().maxDeviation);
    expect(rating.deviation).toBe(350);
  });

  it("widens the deviation from every starting point below the cap", () => {
    for (let deviation = 1; deviation < 350; deviation += 1) {
      expect(updateGlicko2(R(1500, deviation, 60_000, 40), []).deviation).toBeGreaterThan(
        deviation,
      );
    }
  });

  it("raises on a win and lowers on a loss", () => {
    const won = updateGlicko2(R(1500, 100, 60_000, 20), [[R(1500, 100), MatchOutcome.Win]]);
    const lost = updateGlicko2(R(1500, 100, 60_000, 20), [[R(1500, 100), MatchOutcome.Loss]]);
    expect(won.rating).toBeGreaterThan(1500);
    expect(lost.rating).toBeLessThan(1500);
  });

  it("leaves a draw between equals where it was", () => {
    expect(
      updateGlicko2(R(1500, 100, 60_000, 20), [[R(1500, 100), MatchOutcome.Draw]]).rating,
    ).toBe(1500);
  });

  it("narrows the deviation when a player plays", () => {
    expect(
      updateGlicko2(R(1500, 200, 60_000, 5), [[R(1500, 50), MatchOutcome.Win]]).deviation,
    ).toBeLessThan(200);
  });

  it("moves an uncertain player further than a settled one", () => {
    // The whole reason Glicko-2 exists.
    const uncertain = updateGlicko2(R(1500, 300, 60_000, 2), [[R(1500, 50), MatchOutcome.Win]]);
    const settled = updateGlicko2(R(1500, 40, 60_000, 200), [[R(1500, 50), MatchOutcome.Win]]);
    expect(uncertain.rating - 1500).toBeGreaterThan(settled.rating - 1500);
  });

  it("survives the most improbable result there is", () => {
    // A 200-rated player beating a 2200-rated one. `E` here is about one in a
    // hundred thousand, the variance blows up to five figures, and Glickman's
    // upper bracket end passes 22 — outside the domain `fixedExp` is defined
    // on. `delta^2` reaches 10^18, which is 111 times past
    // Number.MAX_SAFE_INTEGER, so before the cap this edition would have
    // returned a number the Python one did not.
    const after = updateGlicko2(R(200, 30, 30_000, 25), [[R(2200, 30), MatchOutcome.Win]]);
    const config = createGlicko2Config();
    expect(after.rating).toBeGreaterThan(200);
    expect(after.volatility).toBeGreaterThanOrEqual(config.minVolatility);
    expect(after.volatility).toBeLessThanOrEqual(config.maxVolatility);
  });

  it("moves a known player less than an unknown one on the same shock", () => {
    const gains = [30, 100, 200, 350].map(
      (deviation) =>
        updateGlicko2(R(200, deviation, 60_000, 25), [[R(2200, deviation), MatchOutcome.Win]])
          .rating - 200,
    );
    expect(gains).toEqual([...gains].sort((a, b) => a - b));
    expect(gains[0]).toBeLessThan(gains[gains.length - 1] as number);
  });

  it("never throws anywhere in the rating range", () => {
    for (let player = 0; player <= 5000; player += 250) {
      for (let opponent = 0; opponent <= 5000; opponent += 500) {
        for (const deviation of [1, 30, 350]) {
          for (const volatility of [1_000, 60_000, 500_000]) {
            for (const outcome of OUTCOMES) {
              expect(() =>
                updateGlicko2(R(player, deviation, volatility, 25), [
                  [R(opponent, deviation), outcome],
                ]),
              ).not.toThrow();
            }
          }
        }
      }
    }
  });

  it("counts a match even when it carried no information", () => {
    // Two players so far apart that `E` rounds to zero: the rating cannot move
    // and the deviation still widens, but the match was played.
    const after = updateGlicko2(R(0, 1, 1_000, 0), [[R(5000, 1), MatchOutcome.Win]]);
    expect(after.matchesPlayed).toBe(1);
  });

  it("holds the volatility inside its bounds everywhere", () => {
    const config = createGlicko2Config();
    for (let player = 0; player <= 5000; player += 500) {
      for (let opponent = 0; opponent <= 5000; opponent += 1000) {
        for (const outcome of OUTCOMES) {
          const after = updateGlicko2(R(player, 350, 60_000, 5), [[R(opponent, 30), outcome]]);
          expect(after.volatility).toBeGreaterThanOrEqual(config.minVolatility);
          expect(after.volatility).toBeLessThanOrEqual(config.maxVolatility);
        }
      }
    }
  });

  it("respects the rating bounds", () => {
    const config = createGlicko2Config({ floor: 1400, ceiling: 1600 });
    expect(
      updateGlicko2(R(1600, 350, 60_000, 0), [[R(5000, 30), MatchOutcome.Win]], config).rating,
    ).toBeLessThanOrEqual(1600);
    expect(
      updateGlicko2(R(1400, 350, 60_000, 0), [[R(0, 30), MatchOutcome.Loss]], config).rating,
    ).toBeGreaterThanOrEqual(1400);
  });

  it("finds an opponent it knows nothing about uninformative", () => {
    const known = updateGlicko2(R(1500, 100, 60_000, 20), [[R(1500, 30), MatchOutcome.Win]]);
    const unknown = updateGlicko2(R(1500, 100, 60_000, 20), [[R(1500, 350), MatchOutcome.Win]]);
    expect(known.rating).toBeGreaterThan(unknown.rating);
  });
});

describe("ratingInterval", () => {
  it("is narrow for a certain player", () => {
    const [low, high] = ratingInterval(R(1500, 30));
    expect(high - low).toBeLessThan(150);
    expect(low).toBeLessThan(1500);
    expect(high).toBeGreaterThan(1500);
  });

  it("is very wide for a newcomer", () => {
    // Glickman's own reading of 350: roughly 800 to 2200.
    const [low, high] = ratingInterval(R(1500, 350));
    expect(low).toBeLessThanOrEqual(815);
    expect(high).toBeGreaterThanOrEqual(2185);
  });

  it("is centred on the rating", () => {
    for (const deviation of [0, 30, 175, 350]) {
      const [low, high] = ratingInterval(R(1500, deviation));
      expect(low + high).toBe(3000);
    }
  });

  it("widens with the confidence asked for", () => {
    const widths = [680, 900, 950, 990].map((confidence) => {
      const [low, high] = ratingInterval(R(1500, 100), confidence);
      return high - low;
    });
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(4);
  });

  it("refuses a confidence it has no quantile for", () => {
    expect(() => ratingInterval(R(1500, 100), 975)).toThrow(ValidationError);
  });
});

describe("determinism", () => {
  it("gives the same answer for the same inputs", () => {
    const run = () =>
      updateGlicko2(R(1500, 200, 60_000, 0), [
        [R(1400, 30), MatchOutcome.Win],
        [R(1700, 300), MatchOutcome.Loss],
      ]);
    expect(run()).toEqual(run());
  });

  it("never mutates what it is given", () => {
    const before = R(1500, 200, 60_000, 7);
    updateElo(before, R(1600, 60), MatchOutcome.Win);
    updateGlicko2(before, [[R(1600, 60), MatchOutcome.Win]]);
    expect(before).toEqual(R(1500, 200, 60_000, 7));
  });
});
