/**
 * The ranked system's invariants, stated as invariants.
 *
 * The sibling of `properties.test.ts`, for the competitive half, and the mirror
 * of `python/tests/test_ranked_properties.py`. The rest of the ranked suite pins
 * down specific numbers, which is the right way to test a formula. It is the
 * wrong way to test a *rule*: "a ladder position never comes back with negative
 * points" is true of every input, and six examples of it prove six inputs.
 *
 * Three of the defects this half of the library was built with are failures of a
 * property stated here and of no example: the volatility solver's two-cycle, the
 * deviation decay's fixed point, and a match quality that depended on which side
 * the caller listed first.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyLeaguePoints,
  balanceTeams,
  comparePositions,
  createGlicko2Config,
  createLadderConfig,
  createLadderPosition,
  createRankedConfig,
  createRankedState,
  createRating,
  createSeason,
  createSeasonResetConfig,
  deserializeRankedState,
  Division,
  expectedScorePermille,
  isApex,
  type LadderPosition,
  LadderOutcome,
  MatchOutcome,
  matchQuality,
  positionForRating,
  RankedEngine,
  ratingForPosition,
  RatingSystem,
  ResetPolicy,
  resetRating,
  serializeRankedState,
  teamRating,
  Tier,
  tierOrder,
  updateElo,
  updateGlicko2,
} from "../src/index.js";

const LADDER = createLadderConfig();
const GLICKO = createGlicko2Config();
const SEASON = createSeason({ id: "S1", name: "One", startsAt: 0, endsAt: 10_000_000 });

const arbRating = fc
  .record({
    rating: fc.integer({ min: 0, max: 5000 }),
    deviation: fc.integer({ min: 1, max: 350 }),
    volatility: fc.integer({ min: 1_000, max: 500_000 }),
    matchesPlayed: fc.integer({ min: 0, max: 5000 }),
  })
  .map((raw) => createRating(raw));

const arbOutcome = fc.constantFrom(MatchOutcome.Win, MatchOutcome.Loss, MatchOutcome.Draw);
const arbSystem = fc.constantFrom(RatingSystem.Elo, RatingSystem.Glicko2);

const arbPosition: fc.Arbitrary<LadderPosition> = fc
  .tuple(
    fc.constantFrom(...Object.values(Tier)),
    fc.constantFrom(Division.Four, Division.Three, Division.Two, Division.One),
    fc.integer({ min: 0, max: 5000 }),
    fc.integer({ min: 0, max: 99 }),
  )
  .map(([tier, division, apexPoints, points]) =>
    isApex(tier)
      ? createLadderPosition({ tier, division: null, leaguePoints: apexPoints })
      : createLadderPosition({ tier, division, leaguePoints: points }),
  );

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

describe("rating properties", () => {
  it("always returns a probability", () => {
    fc.assert(
      fc.property(arbRating, arbRating, arbSystem, (player, opponent, system) => {
        const got = expectedScorePermille(player, opponent, system);
        expect(got).toBeGreaterThanOrEqual(0);
        expect(got).toBeLessThanOrEqual(1000);
      }),
    );
  });

  it("makes the two Elo directions add up", () => {
    fc.assert(
      fc.property(arbRating, arbRating, (player, opponent) => {
        const forward = expectedScorePermille(player, opponent, RatingSystem.Elo);
        const backward = expectedScorePermille(opponent, player, RatingSystem.Elo);
        // Off by one at most: two independent roundings of the same number.
        expect(Math.abs(forward + backward - 1000)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("makes the Glicko-2 directions add up when both sides are equally known", () => {
    // Glicko-2's expectation is asymmetric on purpose: E(A, B) damps by *B's*
    // deviation and E(B, A) by *A's*, so the two directions are different
    // questions. They are complementary only when the system is equally sure
    // about both — which is why `matchQuality` fixes an evaluation order.
    fc.assert(
      fc.property(arbRating, arbRating, (player, opponent) => {
        const same = createRating({ ...opponent, deviation: player.deviation });
        const forward = expectedScorePermille(player, same, RatingSystem.Glicko2);
        const backward = expectedScorePermille(same, player, RatingSystem.Glicko2);
        expect(Math.abs(forward + backward - 1000)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("keeps Elo inside its bounds and leaves the rest alone", () => {
    fc.assert(
      fc.property(arbRating, arbRating, arbOutcome, (player, opponent, outcome) => {
        const after = updateElo(player, opponent, outcome);
        expect(after.rating).toBeGreaterThanOrEqual(0);
        expect(after.rating).toBeLessThanOrEqual(5000);
        expect(after.matchesPlayed).toBe(player.matchesPlayed + 1);
        expect(after.deviation).toBe(player.deviation);
        expect(after.volatility).toBe(player.volatility);
      }),
    );
  });

  it("keeps Glicko-2 inside its bounds", () => {
    fc.assert(
      fc.property(arbRating, arbRating, arbOutcome, (player, opponent, outcome) => {
        const after = updateGlicko2(player, [[opponent, outcome]]);
        expect(after.rating).toBeGreaterThanOrEqual(GLICKO.floor);
        expect(after.rating).toBeLessThanOrEqual(GLICKO.ceiling);
        expect(after.deviation).toBeGreaterThanOrEqual(GLICKO.minDeviation);
        expect(after.deviation).toBeLessThanOrEqual(GLICKO.maxDeviation);
        expect(after.volatility).toBeGreaterThanOrEqual(GLICKO.minVolatility);
        expect(after.volatility).toBeLessThanOrEqual(GLICKO.maxVolatility);
        expect(after.matchesPlayed).toBe(player.matchesPlayed + 1);
      }),
    );
  });

  it("never throws", () => {
    // The property the volatility solver used to violate: its bracket ran past
    // the domain `fixedExp` is defined on, and 816 of 4800 inputs in one sweep
    // failed. No single example test would have found it — the inputs that
    // trigger it are the improbable ones.
    fc.assert(
      fc.property(arbRating, arbRating, arbOutcome, (player, opponent, outcome) => {
        expect(() => updateElo(player, opponent, outcome)).not.toThrow();
        expect(() => updateGlicko2(player, [[opponent, outcome]])).not.toThrow();
        expect(() => updateGlicko2(player, [])).not.toThrow();
      }),
    );
  });

  it("always widens the deviation over an idle period", () => {
    // The property the decay used to violate. Past 109 one period's growth
    // rounded back to the number it started from, so the deviation had a fixed
    // point and an idle player stopped becoming unknown.
    fc.assert(
      fc.property(arbRating, (player) => {
        fc.pre(player.deviation < GLICKO.maxDeviation);
        const after = updateGlicko2(player, []);
        expect(after.deviation).toBeGreaterThan(player.deviation);
        expect(after.rating).toBe(player.rating);
      }),
    );
  });

  it("never lowers a rating on a win or raises one on a loss", () => {
    fc.assert(
      fc.property(arbRating, arbRating, (player, opponent) => {
        fc.pre(player.rating > GLICKO.floor && player.rating < GLICKO.ceiling);
        expect(
          updateGlicko2(player, [[opponent, MatchOutcome.Win]]).rating,
        ).toBeGreaterThanOrEqual(player.rating);
        expect(updateGlicko2(player, [[opponent, MatchOutcome.Loss]]).rating).toBeLessThanOrEqual(
          player.rating,
        );
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(arbRating, arbRating, arbOutcome, (player, opponent, outcome) => {
        expect(updateElo(player, opponent, outcome)).toEqual(updateElo(player, opponent, outcome));
        expect(updateGlicko2(player, [[opponent, outcome]])).toEqual(
          updateGlicko2(player, [[opponent, outcome]]),
        );
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe("ladder properties", () => {
  it("maps every rating to a valid position", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), (rating) => {
        const position = positionForRating(rating, LADDER);
        expect(position.leaguePoints).toBeGreaterThanOrEqual(0);
        expect(isApex(position.tier)).toBe(position.division === null);
        if (!isApex(position.tier)) {
          expect(position.leaguePoints).toBeLessThan(LADDER.pointsPerDivision);
        }
      }),
    );
  });

  it("preserves the ordering of ratings when seeding", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (left, right) => {
          const ordering = Math.sign(left - right);
          const seeded = comparePositions(
            positionForRating(left, LADDER),
            positionForRating(right, LADDER),
          );
          // Two ratings in the same bracket seed equal; otherwise the order
          // is kept.
          expect(seeded === 0 || seeded === ordering).toBe(true);
        },
      ),
    );
  });

  it("round trips a bracket through its rating", () => {
    fc.assert(
      fc.property(arbPosition, (position) => {
        // Above apex the points *are* the rating, one for one, so a Master on
        // 300 points is standing exactly on Grandmaster's threshold and round
        // trips into it. That is the mapping working, not failing.
        if (isApex(position.tier)) {
          const index = tierOrder(position.tier);
          const thresholds = LADDER.tierThresholds;
          const span =
            index + 1 < thresholds.length
              ? (thresholds[index + 1] as number) - (thresholds[index] as number)
              : 10_000;
          fc.pre(position.leaguePoints < span);
        }
        const recovered = positionForRating(ratingForPosition(position, LADDER), LADDER);
        expect(recovered.tier).toBe(position.tier);
        expect(recovered.division).toBe(position.division);
      }),
    );
  });

  it("never produces an impossible position", () => {
    fc.assert(
      fc.property(
        arbPosition,
        fc.boolean(),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 1000 }),
        (position, won, rating, since) => {
          const change = applyLeaguePoints(position, won, rating, LADDER, since);
          expect(change.current.leaguePoints).toBeGreaterThanOrEqual(0);
          expect(isApex(change.current.tier)).toBe(change.current.division === null);
          expect(
            Math.abs(tierOrder(change.current.tier) - tierOrder(position.tier)),
          ).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("is never worth nothing", () => {
    fc.assert(
      fc.property(
        arbPosition,
        fc.boolean(),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 1000 }),
        (position, won, rating, since) => {
          const change = applyLeaguePoints(position, won, rating, LADDER, since);
          // Except during a series, where points deliberately do not move.
          if (
            change.outcome !== LadderOutcome.SeriesAdvanced &&
            change.outcome !== LadderOutcome.SeriesFailed &&
            change.outcome !== LadderOutcome.PromotedTier
          ) {
            expect(change.pointsDelta).not.toBe(0);
          }
        },
      ),
    );
  });

  it("compares antisymmetrically and transitively", () => {
    fc.assert(
      fc.property(arbPosition, arbPosition, (left, right) => {
        expect(comparePositions(left, right) + comparePositions(right, left)).toBe(0);
      }),
    );
    fc.assert(
      fc.property(arbPosition, arbPosition, arbPosition, (a, b, c) => {
        if (comparePositions(a, b) >= 0 && comparePositions(b, c) >= 0) {
          expect(comparePositions(a, c)).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

describe("season properties", () => {
  it("never produces an invalid rating", () => {
    fc.assert(
      fc.property(
        arbRating,
        fc.constantFrom(ResetPolicy.None, ResetPolicy.Soft, ResetPolicy.Hard),
        fc.integer({ min: 0, max: 1000 }),
        (player, policy, pullPermille) => {
          const after = resetRating(player, createSeasonResetConfig({ policy, pullPermille }));
          expect(after.deviation).toBeGreaterThan(0);
          expect(after.volatility).toBeGreaterThan(0);
          expect(after.matchesPlayed).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it("compresses without reordering", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 1000 }),
        (left, right, pullPermille) => {
          fc.pre(left <= right);
          const config = createSeasonResetConfig({ pullPermille });
          expect(
            resetRating(createRating({ rating: left }), config).rating,
          ).toBeLessThanOrEqual(resetRating(createRating({ rating: right }), config).rating);
        },
      ),
    );
  });

  it("is symmetric about the mean", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1500 }),
        fc.integer({ min: 0, max: 1000 }),
        (distance, pullPermille) => {
          const config = createSeasonResetConfig({ pullPermille });
          const up = resetRating(createRating({ rating: 1500 + distance }), config).rating - 1500;
          const down = 1500 - resetRating(createRating({ rating: 1500 - distance }), config).rating;
          expect(up).toBe(down);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------

describe("matchmaking properties", () => {
  it("always returns permille values", () => {
    fc.assert(
      fc.property(arbRating, arbRating, arbSystem, (left, right, system) => {
        const quality = matchQuality(left, right, system);
        expect(quality.qualityPermille).toBeGreaterThanOrEqual(0);
        expect(quality.qualityPermille).toBeLessThanOrEqual(1000);
        expect(quality.winProbabilityPermille).toBeGreaterThanOrEqual(0);
        expect(quality.winProbabilityPermille).toBeLessThanOrEqual(1000);
      }),
    );
  });

  it("is symmetric", () => {
    // The property that used to fail by three permille, because Glicko-2's
    // expectation is asymmetric and the quality squares the imbalance.
    fc.assert(
      fc.property(arbRating, arbRating, arbSystem, (left, right, system) => {
        expect(matchQuality(left, right, system).qualityPermille).toBe(
          matchQuality(right, left, system).qualityPermille,
        );
        expect(
          matchQuality(left, right, system).winProbabilityPermille +
            matchQuality(right, left, system).winProbabilityPermille,
        ).toBe(1000);
      }),
    );
  });

  it("always gives a usable team rating", () => {
    fc.assert(
      fc.property(fc.array(arbRating, { minLength: 1, maxLength: 10 }), (members) => {
        const team = teamRating(members);
        expect(team.deviation).toBeGreaterThanOrEqual(1);
        expect(team.volatility).toBeGreaterThanOrEqual(1);
        expect(team.rating).toBeGreaterThanOrEqual(Math.min(...members.map((m) => m.rating)));
        expect(team.rating).toBeLessThanOrEqual(Math.max(...members.map((m) => m.rating)));
      }),
    );
  });

  it("uses every player exactly once when balancing", () => {
    fc.assert(
      fc.property(fc.array(arbRating, { minLength: 1, maxLength: 5 }), (members) => {
        const players = [...members, ...members]; // guaranteed even, at most ten
        const split = balanceTeams(players);
        expect([...split.left, ...split.right].sort((a, b) => a - b)).toEqual(
          players.map((unused, index) => index),
        );
        expect(split.left.length).toBe(split.right.length);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

describe("engine properties", () => {
  it("stays consistent across a season of any shape", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbRating, arbOutcome), { minLength: 1, maxLength: 60 }),
        arbSystem,
        (matches, system) => {
          const engine = new RankedEngine(
            createRankedConfig({ system, season: SEASON, placementMatches: 10 }),
          );
          let state = createRankedState();

          matches.forEach(([opponent, outcome], index) => {
            const result = engine.recordMatch(state, opponent, outcome, index * 60_000);
            state = result.state;

            expect(state.wins + state.losses + state.draws).toBe(state.seasonMatches);
            expect(state.seasonMatches).toBe(index + 1);
            expect(state.peakRating).toBeGreaterThanOrEqual(state.rating.rating);
            expect(state.rating.rating).toBeGreaterThanOrEqual(0);
            expect(state.rating.rating).toBeLessThanOrEqual(5000);
            expect(state.matchesSincePromotion).toBeGreaterThanOrEqual(0);
            expect(state.position === null).toBe(result.inPlacements);
            if (state.position !== null) {
              expect(state.position.leaguePoints).toBeGreaterThanOrEqual(0);
              expect(isApex(state.position.tier)).toBe(state.position.division === null);
              expect(state.peakPosition).not.toBeNull();
              expect(
                comparePositions(state.peakPosition as LadderPosition, state.position),
              ).toBeGreaterThanOrEqual(0);
            }
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  it("survives a round trip at every point", () => {
    // Nobody keeps a state in memory between matches; they store it and load it
    // back. A state that does not survive that is a ladder that quietly forgets
    // somebody's promotion series.
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbRating, arbOutcome), { minLength: 0, maxLength: 40 }),
        (matches) => {
          const engine = new RankedEngine(
            createRankedConfig({ season: SEASON, placementMatches: 10 }),
          );
          let state = createRankedState();
          matches.forEach(([opponent, outcome], index) => {
            state = engine.recordMatch(state, opponent, outcome, index * 60_000).state;
            expect(deserializeRankedState(serializeRankedState(state))).toEqual(state);
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  it("is unaffected by storing between matches", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbRating, arbOutcome), { minLength: 1, maxLength: 40 }),
        (matches) => {
          const engine = new RankedEngine(
            createRankedConfig({ season: SEASON, placementMatches: 10 }),
          );
          let straight = createRankedState();
          let stored = createRankedState();
          matches.forEach(([opponent, outcome], index) => {
            straight = engine.recordMatch(straight, opponent, outcome, index * 60_000).state;
            stored = deserializeRankedState(serializeRankedState(stored));
            stored = engine.recordMatch(stored, opponent, outcome, index * 60_000).state;
          });
          expect(serializeRankedState(stored)).toEqual(serializeRankedState(straight));
        },
      ),
      { numRuns: 30 },
    );
  });
});
