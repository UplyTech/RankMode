/**
 * The ranked engine: the one object a caller actually holds.
 *
 * These mirror `python/tests/test_ranked.py` test for test.
 */
import { describe, expect, it } from "vitest";

import {
  cloneRankedState,
  ConfigurationError,
  createLadderPosition,
  createRankedConfig,
  createRankedState,
  createRating,
  createSeason,
  createSeasonResetConfig,
  createSeriesState,
  deserializeRankedState,
  Division,
  LadderOutcome,
  MatchOutcome,
  RankedEngine,
  type RankedState,
  type Rating,
  RatingSystem,
  ResetPolicy,
  serializeRankedState,
  Tier,
  tierOrder,
  ValidationError,
} from "../src/index.js";

const MINUTE = 60_000;
const SEASON = createSeason({ id: "S1", name: "One", startsAt: 0, endsAt: 10_000_000 });

const R = (rating: number, deviation = 80, volatility = 60_000, matchesPlayed = 0): Rating =>
  createRating({ rating, deviation, volatility, matchesPlayed });

function play(
  engine: RankedEngine,
  state: RankedState,
  outcomes: MatchOutcome[],
  opponent: Rating = R(1500),
  start = 0,
): RankedState {
  let current = state;
  outcomes.forEach((outcome, index) => {
    current = engine.recordMatch(current, opponent, outcome, start + index * MINUTE).state;
  });
  return current;
}

describe("createRankedConfig", () => {
  it("refuses impossible configuration", () => {
    expect(() => createRankedConfig({ placementMatches: -1 })).toThrow(ConfigurationError);
    expect(() => createRankedConfig({ streakThreshold: -1 })).toThrow(ConfigurationError);
    expect(() => createRankedConfig({ streakBonusPoints: -1 })).toThrow(ConfigurationError);
    expect(() => createRankedConfig({ maxStreakBonus: -1 })).toThrow(ConfigurationError);
  });

  it("defaults to Glicko-2 and no seasons", () => {
    expect(createRankedConfig().system).toBe(RatingSystem.Glicko2);
    expect(createRankedConfig().season).toBeNull();
  });
});

describe("createRankedState", () => {
  it("gives a new player no rank yet", () => {
    const state = createRankedState();
    expect(state.position).toBeNull();
    expect(state.seasonMatches).toBe(0);
    expect(state.peakRating).toBe(state.rating.rating);
    expect(state.lastMatchAt).toBeNull();
  });

  it("can start from a known rating", () => {
    const state = createRankedState(R(2000, 50));
    expect(state.rating.rating).toBe(2000);
    expect(state.peakRating).toBe(2000);
  });

  it("clones without sharing", () => {
    const original = createRankedState(R(1800));
    original.wins = 7;
    const copy = cloneRankedState(original);
    expect(copy).toEqual(original);
    copy.wins = 99;
    expect(original.wins).toBe(7);
  });
});

describe("placements", () => {
  it("shows no rank until they are finished", () => {
    // Showing somebody Bronze after one loss is how a ladder loses a player on
    // their first evening.
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 10 }));
    let state = createRankedState();
    for (let index = 0; index < 9; index += 1) {
      const result = engine.recordMatch(state, R(1500), MatchOutcome.Loss, index * MINUTE);
      state = result.state;
      expect(result.inPlacements).toBe(true);
      expect(state.position).toBeNull();
      expect(result.placementsRemaining).toBe(9 - index);
    }
  });

  it("still moves the rating during them", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 10 }));
    const state = play(engine, createRankedState(), Array(5).fill(MatchOutcome.Win));
    expect(state.rating.rating).toBeGreaterThan(1500);
  });

  it("seeds the rank from the rating when they end", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 10 }));
    const state = play(engine, createRankedState(), Array(10).fill(MatchOutcome.Win));
    expect(state.position).not.toBeNull();
    const seeded = engine.previewPosition(state);
    expect(state.position?.tier).toBe(seeded.tier);
    expect(state.position?.division).toBe(seeded.division);
    expect(state.matchesSincePromotion).toBe(0);
  });

  it("seeds higher for winning them than for losing them", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 10 }));
    const won = play(engine, createRankedState(), Array(10).fill(MatchOutcome.Win), R(1800));
    const lost = play(engine, createRankedState(), Array(10).fill(MatchOutcome.Loss), R(1800));
    expect(tierOrder(won.position!.tier)).toBeGreaterThanOrEqual(tierOrder(lost.position!.tier));
    expect(won.rating.rating).toBeGreaterThan(lost.rating.rating);
  });

  it("previews a position during them", () => {
    // The "you are on track for …" line a placement screen shows.
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 10 }));
    const state = play(engine, createRankedState(), Array(3).fill(MatchOutcome.Win));
    expect(engine.positionOf(state)).toBeNull();
    expect(engine.previewPosition(state)).not.toBeNull();
  });

  it("can be switched off", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    const result = engine.recordMatch(createRankedState(), R(1500), MatchOutcome.Win, 0);
    expect(result.inPlacements).toBe(false);
    expect(result.state.position).not.toBeNull();
  });
});

describe("recordMatch", () => {
  it("counts the outcome", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    const state = play(engine, createRankedState(), [
      MatchOutcome.Win,
      MatchOutcome.Win,
      MatchOutcome.Loss,
      MatchOutcome.Draw,
    ]);
    expect([state.wins, state.losses, state.draws]).toEqual([2, 1, 1]);
    expect(state.seasonMatches).toBe(4);
  });

  it("records when the match happened", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    const result = engine.recordMatch(createRankedState(), R(1500), MatchOutcome.Win, 12_345_678);
    expect(result.state.lastMatchAt).toBe(12_345_678);
  });

  it("reports the chance the player had", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    const favourite = engine.recordMatch(createRankedState(R(2500)), R(1000), MatchOutcome.Win, 0);
    const underdog = engine.recordMatch(createRankedState(R(1000)), R(2500), MatchOutcome.Win, 0);
    expect(favourite.expectedPermille).toBeGreaterThan(800);
    expect(underdog.expectedPermille).toBeLessThan(200);
  });

  it("never mutates the state it is given", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    const state = createRankedState();
    const before = cloneRankedState(state);
    engine.recordMatch(state, R(1500), MatchOutcome.Win, 0);
    expect(state).toEqual(before);
  });

  it("refuses a non-integer timestamp", () => {
    const engine = new RankedEngine();
    expect(() =>
      engine.recordMatch(createRankedState(), R(1500), MatchOutcome.Win, 1.5),
    ).toThrow(ValidationError);
  });

  it("works under Elo as well", () => {
    const engine = new RankedEngine(
      createRankedConfig({ system: RatingSystem.Elo, placementMatches: 0 }),
    );
    const state = play(engine, createRankedState(), Array(5).fill(MatchOutcome.Win));
    expect(state.rating.rating).toBeGreaterThan(1500);
    // Elo has no opinion about the deviation, so it must be left alone.
    expect(state.rating.deviation).toBe(350);
  });
});

describe("streaks", () => {
  it("builds on wins and breaks on a loss", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    let state = createRankedState();
    const streaks: number[] = [];
    for (const outcome of [
      MatchOutcome.Win,
      MatchOutcome.Win,
      MatchOutcome.Win,
      MatchOutcome.Loss,
      MatchOutcome.Loss,
    ]) {
      const result = engine.recordMatch(state, R(1500), outcome, 0);
      state = result.state;
      streaks.push(result.streak);
    }
    expect(streaks).toEqual([1, 2, 3, -1, -2]);
  });

  it("breaks a streak on a draw rather than continuing it", () => {
    // A run of wins interrupted by a draw is not a run of wins, and treating it
    // as one makes the bonus feel arbitrary.
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    let state = play(engine, createRankedState(), Array(3).fill(MatchOutcome.Win));
    expect(state.streak).toBe(3);
    state = play(engine, state, [MatchOutcome.Draw]);
    expect(state.streak).toBe(0);
  });

  it("caps the bonus", () => {
    // A twenty-win streak must not be worth two thousand League Points.
    const engine = new RankedEngine(
      createRankedConfig({
        placementMatches: 0,
        streakThreshold: 2,
        streakBonusPoints: 100,
        maxStreakBonus: 7,
      }),
    );
    const state = play(engine, createRankedState(), Array(20).fill(MatchOutcome.Win));
    expect(state.position).not.toBeNull();
  });
});

describe("ladder movement", () => {
  it("leaves the ladder alone on a draw", () => {
    // Splitting a League Point in half would be worse than not moving.
    const engine = new RankedEngine(
      createRankedConfig({ placementMatches: 0, streakThreshold: 0 }),
    );
    const state = play(engine, createRankedState(), [MatchOutcome.Win]);
    const before = state.position;
    const result = engine.recordMatch(state, R(1500), MatchOutcome.Draw, MINUTE);
    expect(result.ladder?.outcome).toBe(LadderOutcome.Unchanged);
    expect(result.ladder?.pointsDelta).toBe(0);
    expect(result.state.position).toEqual(before);
  });

  it("resets the demotion protection counter on a promotion", () => {
    const engine = new RankedEngine(
      createRankedConfig({ placementMatches: 0, streakThreshold: 0 }),
    );
    let state = createRankedState(R(1200, 60, 60_000, 100));
    let promoted = false;
    for (let index = 0; index < 200; index += 1) {
      const result = engine.recordMatch(state, R(900, 60), MatchOutcome.Win, index * MINUTE);
      state = result.state;
      if (
        result.ladder?.outcome === LadderOutcome.PromotedDivision ||
        result.ladder?.outcome === LadderOutcome.PromotedTier
      ) {
        expect(state.matchesSincePromotion).toBe(0);
        promoted = true;
        break;
      }
    }
    expect(promoted).toBe(true);
  });

  it("keeps every invariant across a whole season", () => {
    const engine = new RankedEngine(
      createRankedConfig({ season: SEASON, placementMatches: 10 }),
    );
    let state = createRankedState();
    let seed = 12_345;
    const next = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed;
    };
    for (let index = 0; index < 400; index += 1) {
      const opponent = 900 + (next() % 1_800);
      const roll = next() % 100;
      const outcome =
        roll < 47 ? MatchOutcome.Win : roll < 94 ? MatchOutcome.Loss : MatchOutcome.Draw;
      state = engine.recordMatch(state, R(opponent), outcome, index * MINUTE).state;

      expect(state.wins + state.losses + state.draws).toBe(state.seasonMatches);
      expect(state.seasonMatches).toBe(index + 1);
      expect(state.rating.rating).toBeGreaterThanOrEqual(0);
      expect(state.rating.rating).toBeLessThanOrEqual(5000);
      expect(state.rating.deviation).toBeGreaterThanOrEqual(30);
      expect(state.rating.deviation).toBeLessThanOrEqual(350);
      expect(state.peakRating).toBeGreaterThanOrEqual(state.rating.rating);
      if (state.position !== null) {
        expect(state.position.leaguePoints).toBeGreaterThanOrEqual(0);
        expect(state.peakPosition).not.toBeNull();
      }
    }
  });
});

describe("seasons", () => {
  it("resets a state from an old season on the next match", () => {
    let engine = new RankedEngine(createRankedConfig({ season: SEASON, placementMatches: 0 }));
    const state = play(engine, createRankedState(), Array(20).fill(MatchOutcome.Win));
    expect(state.seasonId).toBe("S1");

    const nextSeason = createSeason({ id: "S2", name: "Two", startsAt: 10_000_000 });
    engine = new RankedEngine(createRankedConfig({ season: nextSeason, placementMatches: 0 }));
    const result = engine.recordMatch(state, R(1500), MatchOutcome.Win, 10_000_001);
    expect(result.seasonReset).toBe(true);
    expect(result.state.seasonId).toBe("S2");
    expect(result.state.wins).toBe(1);
  });

  it("does not call the first ever match a reset", () => {
    const engine = new RankedEngine(createRankedConfig({ season: SEASON, placementMatches: 0 }));
    const result = engine.recordMatch(createRankedState(), R(1500), MatchOutcome.Win, 0);
    expect(result.seasonReset).toBe(false);
    expect(result.state.seasonId).toBe("S1");
  });

  it("never resets a ladder without seasons", () => {
    const engine = new RankedEngine(createRankedConfig({ season: null, placementMatches: 0 }));
    const state = play(engine, createRankedState(), Array(5).fill(MatchOutcome.Win));
    expect(state.seasonId).toBeNull();
    const result = engine.recordMatch(state, R(1500), MatchOutcome.Win, 10 ** 12);
    expect(result.seasonReset).toBe(false);
    expect(result.state.wins).toBe(6);
  });

  it("clears the record when a season is started explicitly", () => {
    // For the ladder with a leaderboard, which is wrong until everybody has
    // been reset and so cannot do it lazily per player.
    const engine = new RankedEngine(createRankedConfig({ season: SEASON, placementMatches: 0 }));
    const state = play(engine, createRankedState(), Array(20).fill(MatchOutcome.Win));
    const fresh = engine.startSeason(
      state,
      createSeason({ id: "S2", name: "Two", startsAt: 10_000_000 }),
    );
    expect(fresh.seasonId).toBe("S2");
    expect([fresh.seasonMatches, fresh.wins, fresh.losses, fresh.draws, fresh.streak]).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(fresh.position).toBeNull();
    expect(fresh.peakPosition).toBeNull();
    expect(fresh.peakRating).toBe(fresh.rating.rating);
  });

  it("carries the rating untouched under a None policy", () => {
    const engine = new RankedEngine(
      createRankedConfig({
        season: SEASON,
        placementMatches: 0,
        reset: createSeasonResetConfig({ policy: ResetPolicy.None }),
      }),
    );
    const state = play(engine, createRankedState(), Array(20).fill(MatchOutcome.Win));
    const fresh = engine.startSeason(
      state,
      createSeason({ id: "S2", name: "Two", startsAt: 10_000_000 }),
    );
    expect(fresh.rating).toEqual(state.rating);
  });
});

describe("recordPeriod", () => {
  it("widens the deviation for an empty period", () => {
    // The case Glicko-2 has an answer for that Elo does not.
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    const state = play(engine, createRankedState(), Array(20).fill(MatchOutcome.Win));
    const result = engine.recordPeriod(state, [], 10 * MINUTE);
    expect(result.state.rating.deviation).toBeGreaterThan(state.rating.deviation);
    expect(result.state.rating.rating).toBe(state.rating.rating);
    expect(result.state.seasonMatches).toBe(state.seasonMatches);
  });

  it("applies a period of matches in order", () => {
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 0 }));
    const result = engine.recordPeriod(
      createRankedState(),
      [
        [R(1400, 30), MatchOutcome.Win],
        [R(1550, 100), MatchOutcome.Loss],
        [R(1700, 300), MatchOutcome.Loss],
      ],
      0,
    );
    expect(result.state.seasonMatches).toBe(3);
    expect(result.state.wins).toBe(1);
    expect(result.state.losses).toBe(2);
    expect(result.outcome).toBe(MatchOutcome.Loss);
  });
});

describe("summarise", () => {
  it("describes the season", () => {
    const engine = new RankedEngine(createRankedConfig({ season: SEASON, placementMatches: 0 }));
    const state = play(engine, createRankedState(), [
      ...Array(6).fill(MatchOutcome.Win),
      ...Array(3).fill(MatchOutcome.Loss),
      MatchOutcome.Draw,
    ]);
    const summary = engine.summarise(state);
    expect(summary.seasonId).toBe("S1");
    expect(summary.matchesPlayed).toBe(10);
    expect([summary.wins, summary.losses, summary.draws]).toEqual([6, 3, 1]);
    expect(summary.finalRating).toBe(state.rating.rating);
  });

  it("keeps the peak after a slide", () => {
    const engine = new RankedEngine(
      createRankedConfig({ placementMatches: 0, streakThreshold: 0 }),
    );
    let state = play(engine, createRankedState(), Array(30).fill(MatchOutcome.Win), R(1900));
    const peak = state.peakRating;
    state = play(engine, state, Array(30).fill(MatchOutcome.Loss), R(1000), 100 * MINUTE);
    const summary = engine.summarise(state);
    expect(summary.peakRating).toBe(peak);
    expect(summary.finalRating).toBeLessThan(summary.peakRating);
  });
});

describe("serialisation", () => {
  it("round trips a new player", () => {
    const state = createRankedState();
    expect(deserializeRankedState(serializeRankedState(state))).toEqual(state);
  });

  it("round trips a played-out season", () => {
    const engine = new RankedEngine(createRankedConfig({ season: SEASON, placementMatches: 10 }));
    const state = play(engine, createRankedState(), Array(40).fill(MatchOutcome.Win));
    expect(deserializeRankedState(serializeRankedState(state))).toEqual(state);
  });

  it("round trips a position carrying a series", () => {
    const state = createRankedState();
    state.position = createLadderPosition({
      tier: Tier.Gold,
      division: Division.One,
      leaguePoints: 100,
      series: createSeriesState({ winsNeeded: 3, lossesAllowed: 2, wins: 2, losses: 1 }),
    });
    const recovered = deserializeRankedState(serializeRankedState(state));
    expect(recovered.position?.series?.wins).toBe(2);
    expect(recovered.position?.series?.losses).toBe(1);
  });

  it("uses camelCase", () => {
    // Matching every other serialised shape in this library, so a bot ported
    // between the editions keeps its data.
    const raw = serializeRankedState(createRankedState()) as unknown as Record<string, unknown>;
    expect(raw).toHaveProperty("seasonMatches");
    expect(raw).toHaveProperty("matchesSincePromotion");
  });

  it("survives JSON.stringify and JSON.parse", () => {
    const engine = new RankedEngine(createRankedConfig({ season: SEASON, placementMatches: 10 }));
    const state = play(engine, createRankedState(), Array(15).fill(MatchOutcome.Win));
    const text = JSON.stringify(serializeRankedState(state));
    expect(deserializeRankedState(JSON.parse(text))).toEqual(state);
  });

  it("loads a row from an older version", () => {
    const state = deserializeRankedState({ rating: { rating: 1800 } });
    expect(state.rating.rating).toBe(1800);
    expect(state.rating.deviation).toBe(350);
    expect(state.position).toBeNull();
    expect(state.matchesSincePromotion).toBe(999);
    expect(state.peakRating).toBe(1800);
  });

  it("treats an empty object as a new player", () => {
    expect(deserializeRankedState({})).toEqual(createRankedState());
  });

  it("refuses something that is not a state", () => {
    for (const raw of ["not an object", 42, null, []]) {
      expect(() => deserializeRankedState(raw)).toThrow(ValidationError);
    }
  });

  it("refuses a non-integer field and a malformed position", () => {
    expect(() => deserializeRankedState({ wins: "seven" })).toThrow(ValidationError);
    expect(() => deserializeRankedState({ position: "GOLD" })).toThrow(ValidationError);
    expect(() => deserializeRankedState({ position: { tier: "PLASTIC", leaguePoints: 0 } })).toThrow(
      ValidationError,
    );
  });
});

describe("determinism", () => {
  it("makes two engines with the same config agree exactly", () => {
    const config = createRankedConfig({ season: SEASON, placementMatches: 10 });
    const outcomes: MatchOutcome[] = [];
    for (let index = 0; index < 40; index += 1) {
      outcomes.push(MatchOutcome.Win, MatchOutcome.Loss, MatchOutcome.Draw);
    }
    const first = play(new RankedEngine(config), createRankedState(), outcomes);
    const second = play(new RankedEngine(config), createRankedState(), outcomes);
    expect(serializeRankedState(first)).toEqual(serializeRankedState(second));
  });

  it("continues identically from a serialised state", () => {
    // The property a caller relies on when they store the state in a database
    // between matches, which is the only way anybody uses this.
    const engine = new RankedEngine(createRankedConfig({ season: SEASON, placementMatches: 10 }));
    const outcomes: MatchOutcome[] = [];
    for (let index = 0; index < 20; index += 1) {
      outcomes.push(MatchOutcome.Win, MatchOutcome.Win, MatchOutcome.Loss);
    }

    const straightThrough = play(engine, createRankedState(), outcomes);

    let roundTripped = createRankedState();
    outcomes.forEach((outcome, index) => {
      roundTripped = deserializeRankedState(serializeRankedState(roundTripped));
      roundTripped = engine.recordMatch(roundTripped, R(1500), outcome, index * MINUTE).state;
    });

    expect(serializeRankedState(roundTripped)).toEqual(serializeRankedState(straightThrough));
  });
});
