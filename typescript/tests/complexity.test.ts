/**
 * Ceilings, not benchmarks.
 *
 * `SECURITY.md` counts "a denial of service from a plausible input — a curve
 * configuration or a leaderboard size that makes a call take unreasonably long"
 * as a vulnerability. Until 2.0.0 `rankOf` in ORDINAL mode ran a linear
 * `rows.indexOf` inside its loop over `rows`, which made the whole call O(n²)
 * while the Python edition was O(n). Nothing measured it, so nothing noticed.
 *
 * These are deliberately generous. The point is to catch a call that went from
 * linear to quadratic, not to defend a millisecond: a budget tight enough to
 * fail on a slow CI runner is a budget somebody will delete.
 */
import { describe, expect, it } from "vitest";

import {
  balanceTeams,
  buildLeaderboard,
  createEventRule,
  createMemberState,
  createRankedConfig,
  createRankedState,
  createRating,
  ExponentialCurve,
  MatchOutcome,
  positionForRating,
  QuadraticCurve,
  RankedEngine,
  RankEngine,
  rankOf,
  RatingSystem,
  TieMode,
  updateGlicko2,
  type LeaderboardInput,
} from "../src/index.js";

const CURVE = new QuadraticCurve({ base: 100, maxLevel: 500 });

function board(size: number): LeaderboardInput[] {
  // Deliberately many ties: the tie handling is the expensive path.
  return Array.from({ length: size }, (_value, index) => ({
    memberId: `m${index}`,
    totalXp: (index * 7919) % 2500,
  }));
}

function millis(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe("complexity ceilings", () => {
  it("ranks a hundred thousand rows in well under a second", () => {
    const rows = board(100_000);
    expect(millis(() => buildLeaderboard(CURVE, rows))).toBeLessThan(2000);
  });

  it.each([TieMode.Competition, TieMode.Dense, TieMode.Ordinal])(
    "answers rankOf on fifty thousand rows in %s mode without scanning twice",
    (tieMode) => {
      const rows = board(50_000);
      // Quadratic here would be 2.5 billion comparisons: seconds, not
      // milliseconds. The budget is loose enough that only that fails it.
      expect(millis(() => rankOf("m49999", rows, { tieMode }))).toBeLessThan(500);
    },
  );

  it("stays linear in rankOf as the board doubles", () => {
    // The shape of the growth, not its absolute cost. A quadratic call would
    // roughly quadruple; a linear one roughly doubles. The allowance is wide
    // because a single timing on a shared runner is noisy.
    const small = board(20_000);
    const large = board(40_000);
    const options = { tieMode: TieMode.Ordinal };

    // One warm-up each, so the comparison is not against a cold JIT.
    rankOf("m19999", small, options);
    rankOf("m39999", large, options);

    const smallMs = Math.max(millis(() => rankOf("m19999", small, options)), 0.5);
    const largeMs = millis(() => rankOf("m39999", large, options));
    expect(largeMs / smallMs).toBeLessThan(3);
  });

  it("builds a full-length curve table quickly", () => {
    expect(
      millis(() => new QuadraticCurve({ base: 100, maxLevel: 10_000 })),
    ).toBeLessThan(500);
    expect(
      millis(() => new ExponentialCurve({ base: 100, maxLevel: 10_000 })),
    ).toBeLessThan(500);
  });

  it("awards ten thousand times without slowing down", () => {
    const engine = new RankEngine({
      curve: CURVE,
      rules: [
        createEventRule({
          eventType: "message",
          minXp: 10,
          maxXp: 10,
          cooldownSeconds: 0,
          periodCapXp: null,
        }),
      ],
    });
    let state = createMemberState();
    expect(
      millis(() => {
        for (let step = 0; step < 10_000; step += 1) {
          state = engine.award(state, "message", { now: step }).state;
        }
      }),
    ).toBeLessThan(2000);
    expect(state.totalXp).toBe(100_000);
  });
});

describe("ranked complexity ceilings", () => {
  it("runs ten thousand Glicko-2 updates in well under a second", () => {
    // The volatility solver is the only unbounded loop in the library. It
    // bisects, so it takes about two dozen evaluations of a function that calls
    // `fixedExp` — bounded, but not cheap, and a bracket that stopped
    // terminating would show up here as a hang rather than as a wrong number.
    const player = createRating({ rating: 1500, deviation: 200, volatility: 60_000 });
    const opponent = createRating({ rating: 1600, deviation: 80 });
    expect(
      millis(() => {
        for (let step = 0; step < 10_000; step += 1) {
          updateGlicko2(player, [[opponent, MatchOutcome.Win]]);
        }
      }),
    ).toBeLessThan(4000);
  });

  it("plays twenty thousand ranked matches inside its budget", () => {
    // About 50 microseconds a match under Glicko-2, which is twenty thousand a
    // second on one core, and almost all of it is the volatility solver: two
    // dozen bisection steps, each evaluating an exact integer `exp`. That is
    // the price of two editions agreeing to the last unit, and it is the right
    // trade at any load a ladder actually sees.
    //
    // The budget is four times the measured cost because this file also runs
    // under coverage instrumentation, which roughly doubles it. A ceiling that
    // fails on a slow runner is a ceiling somebody deletes.
    const engine = new RankedEngine(createRankedConfig({ placementMatches: 10 }));
    let state = createRankedState();
    const opponent = createRating({ rating: 1500, deviation: 80 });
    expect(
      millis(() => {
        for (let step = 0; step < 20_000; step += 1) {
          state = engine.recordMatch(
            state,
            opponent,
            step % 2 === 0 ? MatchOutcome.Win : MatchOutcome.Loss,
            step * 60_000,
          ).state;
        }
      }),
    ).toBeLessThan(4000);
    expect(state.seasonMatches).toBe(20_000);
  });

  it("plays an Elo match an order of magnitude faster than a Glicko-2 one", () => {
    // The number that decides which system a caller picks under load, stated as
    // a test so it cannot quietly stop being true. Elo needs one logistic;
    // Glicko-2 needs the volatility solve.
    const opponent = createRating({ rating: 1500, deviation: 80 });
    const run = (system: RatingSystem) => {
      const engine = new RankedEngine(createRankedConfig({ system, placementMatches: 10 }));
      let state = createRankedState();
      // A warm-up each, so neither is measured against a cold JIT.
      for (let step = 0; step < 2000; step += 1) {
        state = engine.recordMatch(state, opponent, MatchOutcome.Win, step * 60_000).state;
      }
      state = createRankedState();
      return Math.max(
        millis(() => {
          for (let step = 0; step < 10_000; step += 1) {
            state = engine.recordMatch(state, opponent, MatchOutcome.Win, step * 60_000).state;
          }
        }),
        0.5,
      );
    };
    expect(run(RatingSystem.Elo)).toBeLessThan(run(RatingSystem.Glicko2));
  });

  it("seeds a million ratings onto the ladder quickly", () => {
    expect(
      millis(() => {
        for (let rating = 0; rating < 1_000_000; rating += 1) {
          positionForRating(rating % 5000);
        }
      }),
    ).toBeLessThan(3000);
  });

  it("balances the largest team it accepts inside its budget", () => {
    // Exhaustive over 92,378 splits at twenty players, each of which builds two
    // team ratings. That is the reason for the cap, and this is the number the
    // cap was chosen against.
    const players = Array.from({ length: 20 }, (_value, index) =>
      createRating({ rating: 1000 + ((index * 373) % 1700), deviation: 40 + index * 7 }),
    );
    expect(millis(() => balanceTeams(players, RatingSystem.Glicko2))).toBeLessThan(10_000);
  });

  it("stays linear in balanceTeams as the group grows by two", () => {
    // The split count roughly doubles for every two players. Anything worse
    // than that is a change in the algorithm, not in the machine.
    const make = (size: number) =>
      Array.from({ length: size }, (_value, index) =>
        createRating({ rating: 1000 + ((index * 373) % 1700), deviation: 40 }),
      );
    balanceTeams(make(12));
    const twelve = Math.max(millis(() => balanceTeams(make(12))), 0.5);
    const fourteen = millis(() => balanceTeams(make(14)));
    expect(fourteen / twelve).toBeLessThan(12);
  });
});
