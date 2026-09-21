/**
 * Everything the barrel file advertises is really there, and is really usable.
 *
 * `src/index.ts` was excluded from the coverage report until 2.0.0, which made
 * the one file where a missing export lives the one file nothing measured. The
 * Python edition had exactly that bug in its own barrel: a name in `__all__`
 * that the module never imported, and 473 tests did not notice.
 */
import { describe, expect, it } from "vitest";

import * as rankmode from "../src/index.js";
import RankEngineDefault from "../src/index.js";

/** The names the README's five-minute example uses. */
const README_SURFACE = [
  "RankEngine",
  "createEventRule",
  "createMemberState",
  "buildLeaderboard",
  "previewMigration",
  "QuadraticCurve",
  "AwardOutcome",
  "CryptoRandomSource",
] as const;

describe("public surface", () => {
  it("exports everything the README's first example needs", () => {
    for (const name of README_SURFACE) {
      expect(rankmode, `missing export: ${name}`).toHaveProperty(name);
      expect(rankmode[name], `${name} is exported as undefined`).toBeDefined();
    }
  });

  it("exports no undefined bindings", () => {
    // A re-export of a name that was renamed at the source shows up here as
    // `undefined` rather than as a build error.
    const undefinedExports = Object.entries(rankmode)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    expect(undefinedExports).toEqual([]);
  });

  it("has a default export, and it is RankEngine", () => {
    expect(RankEngineDefault).toBe(rankmode.RankEngine);
  });

  it("exports every error class, and they all extend RankModeError", () => {
    for (const name of [
      "ConfigurationError",
      "ValidationError",
      "CurveError",
      "XpOverflowError",
      "MigrationError",
      "LadderError",
      "SeasonError",
    ] as const) {
      const ErrorClass = rankmode[name];
      expect(ErrorClass, name).toBeDefined();
      expect(new ErrorClass("x")).toBeInstanceOf(rankmode.RankModeError);
    }
  });

  it("exports every curve shape, and each builds", () => {
    expect(new rankmode.LinearCurve({ base: 10, maxLevel: 3 }).maxLevel).toBe(3);
    expect(new rankmode.QuadraticCurve({ base: 10, maxLevel: 3 }).maxLevel).toBe(3);
    expect(new rankmode.ExponentialCurve({ base: 10, maxLevel: 3 }).maxLevel).toBe(3);
    expect(new rankmode.TabularCurve([0, 1, 2]).maxLevel).toBe(2);
    expect(rankmode.defaultCurve()).toBeInstanceOf(rankmode.QuadraticCurve);
  });

  it("exports the constants both editions must agree on", () => {
    expect(rankmode.MAX_TOTAL_XP).toBe(Number.MAX_SAFE_INTEGER);
    expect(rankmode.MIN_TOTAL_XP).toBe(-Number.MAX_SAFE_INTEGER);
    expect(rankmode.PERMILLE_ONE).toBe(1000);
    expect(rankmode.GLOBAL_CAP_KEY).toBe("*");
  });

  it("reports `changed` on every result, the way the Python edition does", () => {
    // Until 2.0.0 only Python had this, so the two READMEs showed two different
    // idioms for the same check.
    const engine = new rankmode.RankEngine({ rules: rankmode.defaultRules() });
    const awarded = engine.award(rankmode.createMemberState(), "message", {
      now: 1,
      baseXp: 20,
    });
    expect(awarded.changed).toBe(true);
    expect(awarded.changed).toBe(awarded.awardedXp !== 0);

    const blocked = engine.award(awarded.state, "message", { now: 2, baseXp: 20 });
    expect(blocked.outcome).toBe(rankmode.AwardOutcome.Cooldown);
    expect(blocked.changed).toBe(false);
  });

  it("exports the whole ranked surface, and every piece works", () => {
    // The ranked half is a second engine with its own vocabulary. A name missing
    // from the barrel is not a build error in either edition — it is a caller
    // who cannot reach a feature the README says exists.
    const RANKED_SURFACE = [
      "RankedEngine",
      "createRankedConfig",
      "createRankedState",
      "cloneRankedState",
      "serializeRankedState",
      "deserializeRankedState",
      "MatchOutcome",
      "RatingSystem",
      "createRating",
      "createEloConfig",
      "createGlicko2Config",
      "expectedScorePermille",
      "updateElo",
      "updateGlicko2",
      "ratingInterval",
      "scorePermille",
      "kFor",
      "Tier",
      "Division",
      "LadderOutcome",
      "createLadderConfig",
      "createLadderPosition",
      "createSeriesState",
      "positionForRating",
      "ratingForPosition",
      "comparePositions",
      "formatPosition",
      "applyLeaguePoints",
      "defaultTiers",
      "tierOrder",
      "isApex",
      "divisionLabel",
      "usesSeries",
      "isSeriesWon",
      "isSeriesLost",
      "isSeriesOver",
      "ResetPolicy",
      "createSeason",
      "isWithin",
      "seasonFor",
      "createSeasonResetConfig",
      "resetRating",
      "resetPosition",
      "winRatePermille",
      "matchQuality",
      "isAcceptable",
      "teamRating",
      "balanceTeams",
      "SCALE",
      "toFixed",
      "fromFixed",
      "isqrt",
      "fixedMul",
      "fixedDiv",
      "fixedSqrt",
      "fixedLn",
      "fixedExp",
      "DEFAULT_RATING",
      "DEFAULT_DEVIATION",
      "DEFAULT_VOLATILITY",
    ] as const;

    for (const name of RANKED_SURFACE) {
      expect(rankmode, `missing export: ${name}`).toHaveProperty(name);
      expect(rankmode[name], `${name} is exported as undefined`).toBeDefined();
    }
  });

  it("runs a ranked match end to end through the barrel alone", () => {
    // Nothing imported from a submodule: exactly what a caller can reach.
    const engine = new rankmode.RankedEngine(
      rankmode.createRankedConfig({ placementMatches: 0 }),
    );
    const result = engine.recordMatch(
      rankmode.createRankedState(),
      rankmode.createRating({ rating: 1400 }),
      rankmode.MatchOutcome.Win,
      0,
    );
    expect(result.state.position).not.toBeNull();
    expect(rankmode.formatPosition(result.state.position!)).toMatch(/, \d+ LP$/);
    expect(
      rankmode.deserializeRankedState(rankmode.serializeRankedState(result.state)),
    ).toEqual(result.state);
  });

  it("reports progress as a ratio as well as in permille", () => {
    const progress = new rankmode.QuadraticCurve({ base: 100 }).progressForTotalXp(150);
    expect(progress.progressRatio).toBeCloseTo(progress.progressPermille / 1000, 10);
  });
});
