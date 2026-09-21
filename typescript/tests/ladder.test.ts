/**
 * The ladder: tiers, divisions, League Points and promotion series.
 *
 * Almost every rule in it exists because the obvious behaviour felt wrong
 * rather than because it was arithmetically incorrect. The tests say which is
 * which.
 *
 * These mirror `python/tests/test_ladder.py` test for test.
 */
import { describe, expect, it } from "vitest";

import {
  applyLeaguePoints,
  ConfigurationError,
  comparePositions,
  createLadderConfig,
  createLadderPosition,
  createSeriesState,
  defaultTiers,
  Division,
  divisionLabel,
  formatPosition,
  isApex,
  LadderError,
  LadderOutcome,
  type LadderPosition,
  type SeriesState,
  positionForRating,
  ratingForPosition,
  Tier,
  tierOrder,
  usesSeries,
  ValidationError,
} from "../src/index.js";

const LADDER = createLadderConfig();
const APEX = [Tier.Master, Tier.Grandmaster, Tier.Challenger];
const DIVISIONS = [Division.Four, Division.Three, Division.Two, Division.One];

const P = (
  tier: Tier,
  division: Division | null,
  leaguePoints: number,
  series: SeriesState | null = null,
): LadderPosition => createLadderPosition({ tier, division, leaguePoints, series });

describe("tiers", () => {
  it("has nine, lowest first", () => {
    expect(defaultTiers()).toHaveLength(9);
    expect(defaultTiers()[0]).toBe(Tier.Iron);
    expect(defaultTiers()[8]).toBe(Tier.Challenger);
  });

  it("orders them by index", () => {
    expect(defaultTiers().map(tierOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("gives the top three no divisions", () => {
    for (const tier of defaultTiers()) {
      expect(isApex(tier)).toBe(APEX.includes(tier));
    }
  });
});

describe("divisions", () => {
  it("makes a larger value a better position", () => {
    expect(Division.Four).toBeLessThan(Division.Three);
    expect(Division.Three).toBeLessThan(Division.Two);
    expect(Division.Two).toBeLessThan(Division.One);
  });

  it("labels them with the numerals a player reads", () => {
    expect(divisionLabel(Division.Four)).toBe("IV");
    expect(divisionLabel(Division.Three)).toBe("III");
    expect(divisionLabel(Division.Two)).toBe("II");
    expect(divisionLabel(Division.One)).toBe("I");
  });
});

describe("createLadderPosition", () => {
  it("refuses a division in an apex tier", () => {
    expect(() => P(Tier.Master, Division.One, 0)).toThrow(LadderError);
  });

  it("requires a division below apex", () => {
    expect(() => P(Tier.Gold, null, 0)).toThrow(LadderError);
  });

  it("refuses negative points", () => {
    expect(() => P(Tier.Gold, Division.Four, -1)).toThrow(ValidationError);
  });
});

describe("createLadderConfig", () => {
  it("refuses impossible configuration", () => {
    expect(() => createLadderConfig({ tierThresholds: [0, 100] })).toThrow(ConfigurationError);
    expect(() =>
      createLadderConfig({ tierThresholds: [0, 800, 800, 1400, 1700, 2000, 2300, 2600, 2900] }),
    ).toThrow(ConfigurationError);
    expect(() => createLadderConfig({ pointsPerDivision: 0 })).toThrow(ConfigurationError);
    expect(() => createLadderConfig({ basePointsGain: -1 })).toThrow(ConfigurationError);
    expect(() => createLadderConfig({ adjustmentSpanPermille: 1001 })).toThrow(
      ConfigurationError,
    );
    expect(() => createLadderConfig({ demotionProtectionMatches: -1 })).toThrow(
      ConfigurationError,
    );
  });

  it("can switch series off", () => {
    expect(usesSeries(createLadderConfig())).toBe(true);
    expect(usesSeries(createLadderConfig({ seriesOnTierPromotion: false }))).toBe(false);
    expect(usesSeries(createLadderConfig({ seriesWinsNeeded: 0 }))).toBe(false);
  });
});

describe("seeding a rating onto the ladder", () => {
  it("puts the bottom at Iron IV", () => {
    const position = positionForRating(0, LADDER);
    expect(position.tier).toBe(Tier.Iron);
    expect(position.division).toBe(Division.Four);
    expect(position.leaguePoints).toBe(0);
  });

  it("gives the top no division", () => {
    const position = positionForRating(3500, LADDER);
    expect(position.tier).toBe(Tier.Challenger);
    expect(position.division).toBeNull();
    // Above apex the points are the ladder: one per rating point.
    expect(position.leaguePoints).toBe(3500 - 2900);
  });

  it("lands each threshold at the bottom of its own tier", () => {
    LADDER.tierThresholds.forEach((threshold, index) => {
      const position = positionForRating(threshold, LADDER);
      expect(position.tier).toBe(defaultTiers()[index]);
      if (!isApex(position.tier)) {
        expect(position.division).toBe(Division.Four);
        expect(position.leaguePoints).toBe(0);
      }
    });
  });

  it("puts one below a threshold in the tier below", () => {
    for (let index = 1; index < LADDER.tierThresholds.length; index += 1) {
      const position = positionForRating((LADDER.tierThresholds[index] as number) - 1, LADDER);
      expect(position.tier).toBe(defaultTiers()[index - 1]);
    }
  });

  it("is monotone across the whole range", () => {
    let previous = positionForRating(0, LADDER);
    for (let rating = 1; rating <= 4000; rating += 1) {
      const current = positionForRating(rating, LADDER);
      expect(comparePositions(current, previous)).toBeGreaterThanOrEqual(0);
      previous = current;
    }
  });

  it("round trips back into the same bracket", () => {
    for (let rating = 0; rating <= 4000; rating += 3) {
      const position = positionForRating(rating, LADDER);
      const recovered = positionForRating(ratingForPosition(position, LADDER), LADDER);
      expect(recovered.tier).toBe(position.tier);
      expect(recovered.division).toBe(position.division);
    }
  });

  it("seeds a rating below the floor to the bottom", () => {
    // Found by the differential harness, in both editions at once. A negative
    // rating made the offset into the tier negative, the floor division sent
    // the division index to -1, and there is no division zero: Python raised
    // and this edition cast the -1 and returned a position with division zero
    // that no other function accepts.
    for (const rating of [-1, -100, -1_000_000]) {
      const position = positionForRating(rating, LADDER);
      expect(position.tier).toBe(Tier.Iron);
      expect(position.division).toBe(Division.Four);
      expect(position.leaguePoints).toBe(0);
    }
  });

  it("refuses a non-integer rating", () => {
    expect(() => positionForRating(1500.5, LADDER)).toThrow(ValidationError);
  });

  it("makes every division of every tier reachable", () => {
    const seen = new Set<string>();
    for (let rating = 0; rating <= 4000; rating += 1) {
      const position = positionForRating(rating, LADDER);
      seen.add(`${position.tier}/${position.division ?? "-"}`);
    }
    const expected = new Set<string>();
    for (const tier of defaultTiers()) {
      if (isApex(tier)) {
        expected.add(`${tier}/-`);
      } else {
        for (const division of DIVISIONS) expected.add(`${tier}/${division}`);
      }
    }
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});

describe("formatPosition", () => {
  it("reads the way a player would say it", () => {
    expect(formatPosition(P(Tier.Gold, Division.Two, 47))).toBe("Gold II, 47 LP");
    expect(formatPosition(P(Tier.Iron, Division.Four, 0))).toBe("Iron IV, 0 LP");
  });

  it("gives an apex position no numeral", () => {
    expect(formatPosition(P(Tier.Challenger, null, 1234))).toBe("Challenger, 1234 LP");
  });
});

describe("comparePositions", () => {
  it("puts tier before division before points", () => {
    expect(comparePositions(P(Tier.Gold, Division.Four, 0), P(Tier.Silver, Division.One, 99))).toBe(
      1,
    );
    expect(comparePositions(P(Tier.Gold, Division.Three, 0), P(Tier.Gold, Division.Four, 99))).toBe(
      1,
    );
    expect(comparePositions(P(Tier.Gold, Division.Four, 50), P(Tier.Gold, Division.Four, 49))).toBe(
      1,
    );
  });

  it("compares equal positions equal", () => {
    expect(comparePositions(P(Tier.Gold, Division.Two, 30), P(Tier.Gold, Division.Two, 30))).toBe(
      0,
    );
  });

  it("is antisymmetric", () => {
    const positions: LadderPosition[] = [];
    for (let rating = 0; rating <= 4000; rating += 137) {
      positions.push(positionForRating(rating, LADDER));
    }
    // Stated as a sum: negating a zero is how JavaScript produces `-0`, and
    // `a === -b` would then be testing the test rather than the function.
    for (const left of positions) {
      for (const right of positions) {
        expect(comparePositions(left, right) + comparePositions(right, left)).toBe(0);
      }
    }
  });
});

describe("League Points", () => {
  it("gains on a win and costs on a loss", () => {
    const position = P(Tier.Gold, Division.Three, 50);
    const rating = ratingForPosition(position, LADDER);
    expect(applyLeaguePoints(position, true, rating, LADDER).pointsDelta).toBeGreaterThan(0);
    expect(applyLeaguePoints(position, false, rating, LADDER).pointsDelta).toBeLessThan(0);
  });

  it("makes an under-ranked player climb faster", () => {
    // The entire reason the rating and the ladder are separate numbers.
    const position = P(Tier.Gold, Division.Three, 50);
    const matching = ratingForPosition(position, LADDER);
    const under = applyLeaguePoints(position, true, matching + 400, LADDER).pointsDelta;
    const even = applyLeaguePoints(position, true, matching, LADDER).pointsDelta;
    const over = applyLeaguePoints(position, true, matching - 400, LADDER).pointsDelta;
    expect(under).toBeGreaterThan(even);
    expect(even).toBeGreaterThan(over);
  });

  it("makes an under-ranked player lose less", () => {
    const position = P(Tier.Gold, Division.Three, 50);
    const matching = ratingForPosition(position, LADDER);
    const under = applyLeaguePoints(position, false, matching + 400, LADDER).pointsDelta;
    const over = applyLeaguePoints(position, false, matching - 400, LADDER).pointsDelta;
    expect(under).toBeGreaterThan(over);
  });

  it("is always worth at least one point", () => {
    // Rounding to zero would make a match feel like it did not happen.
    for (let rating = 0; rating <= 4000; rating += 50) {
      for (const won of [true, false]) {
        for (const tier of defaultTiers()) {
          const position = P(tier, isApex(tier) ? null : Division.Three, 50);
          expect(applyLeaguePoints(position, won, rating, LADDER).pointsDelta).not.toBe(0);
        }
      }
    }
  });

  it("can have the adjustment switched off", () => {
    const config = createLadderConfig({ adjustmentSpanPermille: 0 });
    const position = P(Tier.Gold, Division.Three, 50);
    for (const rating of [0, 1500, 4000]) {
      expect(applyLeaguePoints(position, true, rating, config).pointsDelta).toBe(20);
      expect(applyLeaguePoints(position, false, rating, config).pointsDelta).toBe(-18);
    }
  });
});

describe("promotion", () => {
  it("moves up a division when crossing a hundred", () => {
    const position = P(Tier.Gold, Division.Four, 95);
    const change = applyLeaguePoints(position, true, ratingForPosition(position, LADDER), LADDER);
    expect(change.outcome).toBe(LadderOutcome.PromotedDivision);
    expect(change.current.division).toBe(Division.Three);
    expect(change.tierChanged).toBe(false);
    expect(change.current.leaguePoints).toBe(95 + change.pointsDelta - 100);
  });

  it("needs no series for a division promotion", () => {
    // They happen too often for a ceremony.
    const position = P(Tier.Gold, Division.Three, 99);
    const change = applyLeaguePoints(position, true, ratingForPosition(position, LADDER), LADDER);
    expect(change.current.series).toBeNull();
    expect(change.seriesActive).toBe(false);
  });

  it("starts a series when leaving a tier", () => {
    const position = P(Tier.Gold, Division.One, 99);
    const change = applyLeaguePoints(position, true, ratingForPosition(position, LADDER), LADDER);
    expect(change.outcome).toBe(LadderOutcome.SeriesStarted);
    expect(change.current.series).not.toBeNull();
    expect(change.current.tier).toBe(Tier.Gold);
    expect(change.seriesActive).toBe(true);
  });

  it("promotes directly when series are off", () => {
    const config = createLadderConfig({ seriesOnTierPromotion: false });
    const position = P(Tier.Gold, Division.One, 99);
    const change = applyLeaguePoints(position, true, ratingForPosition(position, config), config);
    expect(change.outcome).toBe(LadderOutcome.PromotedTier);
    expect(change.current.tier).toBe(Tier.Platinum);
    expect(change.current.division).toBe(Division.Four);
    expect(change.tierChanged).toBe(true);
  });

  it("arrives in apex without a division", () => {
    const config = createLadderConfig({ seriesOnTierPromotion: false });
    const position = P(Tier.Diamond, Division.One, 99);
    const change = applyLeaguePoints(position, true, ratingForPosition(position, config), config);
    expect(change.current.tier).toBe(Tier.Master);
    expect(change.current.division).toBeNull();
  });

  it("has nowhere to go at the top", () => {
    const position = P(Tier.Challenger, null, 5000);
    const change = applyLeaguePoints(position, true, 4000, LADDER);
    expect(change.current.tier).toBe(Tier.Challenger);
    expect(change.current.leaguePoints).toBeGreaterThan(5000);
  });
});

describe("promotion series", () => {
  it("advances on a win", () => {
    const position = P(
      Tier.Gold,
      Division.One,
      100,
      createSeriesState({ winsNeeded: 3, lossesAllowed: 2 }),
    );
    const change = applyLeaguePoints(position, true, 1500, LADDER);
    expect(change.outcome).toBe(LadderOutcome.SeriesAdvanced);
    expect(change.current.series?.wins).toBe(1);
  });

  it("does not move points during one", () => {
    const position = P(
      Tier.Gold,
      Division.One,
      100,
      createSeriesState({ winsNeeded: 3, lossesAllowed: 2 }),
    );
    for (const won of [true, false]) {
      const change = applyLeaguePoints(position, won, 1500, LADDER);
      expect(change.pointsDelta).toBe(0);
      expect(change.current.leaguePoints).toBe(100);
    }
  });

  it("promotes on the third win", () => {
    const position = P(
      Tier.Gold,
      Division.One,
      100,
      createSeriesState({ winsNeeded: 3, lossesAllowed: 2, wins: 2 }),
    );
    const change = applyLeaguePoints(position, true, 1500, LADDER);
    expect(change.outcome).toBe(LadderOutcome.PromotedTier);
    expect(change.current.tier).toBe(Tier.Platinum);
    expect(change.current.series).toBeNull();
    expect(change.tierChanged).toBe(true);
  });

  it("fails on the third loss and costs three quarters of a division", () => {
    const position = P(
      Tier.Gold,
      Division.One,
      100,
      createSeriesState({ winsNeeded: 3, lossesAllowed: 2, losses: 2 }),
    );
    const change = applyLeaguePoints(position, false, 1500, LADDER);
    expect(change.outcome).toBe(LadderOutcome.SeriesFailed);
    expect(change.current.tier).toBe(Tier.Gold);
    expect(change.current.series).toBeNull();
    // Failing should cost something without erasing the climb to it.
    expect(change.current.leaguePoints).toBe(75);
  });

  it("plays out to a win", () => {
    const start = P(Tier.Gold, Division.One, 99);
    let change = applyLeaguePoints(start, true, ratingForPosition(start, LADDER), LADDER);
    const outcomes = [change.outcome];
    for (let index = 0; index < 3; index += 1) {
      change = applyLeaguePoints(change.current, true, 1500, LADDER);
      outcomes.push(change.outcome);
    }
    expect(outcomes).toEqual([
      LadderOutcome.SeriesStarted,
      LadderOutcome.SeriesAdvanced,
      LadderOutcome.SeriesAdvanced,
      LadderOutcome.PromotedTier,
    ]);
    expect(change.current.tier).toBe(Tier.Platinum);
  });

  it("refuses impossible configuration", () => {
    expect(() => createSeriesState({ winsNeeded: 0, lossesAllowed: 2 })).toThrow(
      ConfigurationError,
    );
    expect(() => createSeriesState({ winsNeeded: 3, lossesAllowed: -1 })).toThrow(
      ConfigurationError,
    );
    expect(() => createSeriesState({ winsNeeded: 3, lossesAllowed: 2, wins: -1 })).toThrow(
      ValidationError,
    );
  });
});

describe("demotion", () => {
  it("drops a division when the points run out", () => {
    const position = P(Tier.Gold, Division.Three, 5);
    const change = applyLeaguePoints(
      position,
      false,
      ratingForPosition(position, LADDER),
      LADDER,
      999,
    );
    expect(change.outcome).toBe(LadderOutcome.DemotedDivision);
    expect(change.current.division).toBe(Division.Four);
    expect(change.current.leaguePoints).toBe(100 + 5 + change.pointsDelta);
  });

  it("drops a tier out of division four", () => {
    const position = P(Tier.Gold, Division.Four, 5);
    const change = applyLeaguePoints(
      position,
      false,
      ratingForPosition(position, LADDER),
      LADDER,
      999,
    );
    expect(change.outcome).toBe(LadderOutcome.DemotedTier);
    expect(change.current.tier).toBe(Tier.Silver);
    expect(change.current.division).toBe(Division.One);
    // Landing at 75 rather than 99, so one win does not immediately start
    // another series. Bouncing on a tier boundary is the worst experience a
    // ladder has.
    expect(change.current.leaguePoints).toBe(75);
  });

  it("protects a freshly promoted player", () => {
    const position = P(Tier.Gold, Division.Four, 5);
    const change = applyLeaguePoints(
      position,
      false,
      ratingForPosition(position, LADDER),
      LADDER,
      0,
    );
    expect(change.outcome).toBe(LadderOutcome.FloorHeld);
    expect(change.current.tier).toBe(Tier.Gold);
    expect(change.current.leaguePoints).toBe(0);
  });

  it("expires the protection", () => {
    const position = P(Tier.Gold, Division.Four, 5);
    const rating = ratingForPosition(position, LADDER);
    expect(applyLeaguePoints(position, false, rating, LADDER, 2).outcome).toBe(
      LadderOutcome.FloorHeld,
    );
    expect(applyLeaguePoints(position, false, rating, LADDER, 3).outcome).toBe(
      LadderOutcome.DemotedTier,
    );
  });

  it("holds at the bottom of the ladder", () => {
    const change = applyLeaguePoints(P(Tier.Iron, Division.Four, 5), false, 0, LADDER, 999);
    expect(change.outcome).toBe(LadderOutcome.FloorHeld);
    expect(change.current.tier).toBe(Tier.Iron);
    expect(change.current.leaguePoints).toBe(0);
  });

  it("can be switched off entirely", () => {
    const config = createLadderConfig({ allowTierDemotion: false });
    const change = applyLeaguePoints(P(Tier.Gold, Division.Four, 5), false, 1400, config, 999);
    expect(change.outcome).toBe(LadderOutcome.FloorHeld);
    expect(change.current.tier).toBe(Tier.Gold);
  });

  it("stops at a tier floor", () => {
    const config = createLadderConfig({ tierFloor: Tier.Gold });
    const change = applyLeaguePoints(P(Tier.Gold, Division.Four, 5), false, 1400, config, 999);
    expect(change.outcome).toBe(LadderOutcome.FloorHeld);
    expect(change.current.tier).toBe(Tier.Gold);
  });

  it("drops out of apex into the tier below", () => {
    const change = applyLeaguePoints(P(Tier.Master, null, 5), false, 2300, LADDER, 999);
    expect(change.outcome).toBe(LadderOutcome.DemotedTier);
    expect(change.current.tier).toBe(Tier.Diamond);
    expect(change.current.division).toBe(Division.One);
  });
});

describe("invariants", () => {
  it("never comes back with negative points", () => {
    for (const tier of defaultTiers()) {
      const divisions = isApex(tier) ? [null] : DIVISIONS;
      for (const division of divisions) {
        for (const points of [0, 1, 50, 99]) {
          const position = P(tier, division, points);
          for (const won of [true, false]) {
            for (let rating = 0; rating <= 4000; rating += 250) {
              for (const since of [0, 3, 999]) {
                expect(
                  applyLeaguePoints(position, won, rating, LADDER, since).current.leaguePoints,
                ).toBeGreaterThanOrEqual(0);
              }
            }
          }
        }
      }
    }
  });

  it("never comes back with an apex tier carrying a division", () => {
    for (const tier of defaultTiers()) {
      const divisions = isApex(tier) ? [null] : DIVISIONS;
      for (const division of divisions) {
        for (const won of [true, false]) {
          const change = applyLeaguePoints(P(tier, division, 99), won, 2500, LADDER, 999);
          expect(isApex(change.current.tier)).toBe(change.current.division === null);
        }
      }
    }
  });

  it("never mutates the position it is given", () => {
    const position = P(Tier.Gold, Division.One, 99);
    applyLeaguePoints(position, true, 1500, LADDER);
    applyLeaguePoints(position, false, 1500, LADDER);
    expect(position.leaguePoints).toBe(99);
    expect(position.division).toBe(Division.One);
    expect(position.series).toBeNull();
  });

  it("moves a tier by at most one step per match", () => {
    for (const tier of defaultTiers()) {
      const divisions = isApex(tier) ? [null] : DIVISIONS;
      for (const division of divisions) {
        for (const points of [0, 99]) {
          for (const won of [true, false]) {
            const change = applyLeaguePoints(P(tier, division, points), won, 2000, LADDER, 999);
            expect(Math.abs(tierOrder(change.current.tier) - tierOrder(tier))).toBeLessThanOrEqual(
              1,
            );
          }
        }
      }
    }
  });
});
