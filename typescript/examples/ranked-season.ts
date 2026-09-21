/**
 * A whole competitive season, in one runnable file.
 *
 *     npx vite-node examples/ranked-season.ts
 *
 * Everything the ranked half does, in the order a caller meets it: placements,
 * seeding, climbing, a promotion series, demotion protection, a season summary
 * and the reset into the next season. Nothing here reads a clock or a random
 * source — the timestamps are arguments and the results are a fixed list, so
 * this file prints the same thing every time it is run.
 *
 * It also prints the same thing as `python/examples/ranked_season.py`: 81 of its
 * 87 lines are byte-identical, and the six that are not are `json.dumps` putting
 * a space after a colon and Python spelling `True` with a capital. Every number
 * matches. That is the whole promise of this library, in a form you can check by
 * running both and diffing the output.
 */
import {
  balanceTeams,
  createRankedConfig,
  createRankedState,
  createRating,
  createSeason,
  createSeasonResetConfig,
  deserializeRankedState,
  formatPosition,
  isAcceptable,
  type LadderPosition,
  MatchOutcome,
  matchQuality,
  RankedEngine,
  type RankedState,
  type Rating,
  ratingInterval,
  RatingSystem,
  ResetPolicy,
  serializeRankedState,
} from "../src/index.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SEASON_ONE_START = 1_767_225_600_000; // 1 January 2026
const SEASON_TWO_START = SEASON_ONE_START + 90 * DAY_MS;

const line = (title: string): void => {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
};

const show = (position: LadderPosition | null): string =>
  position === null ? "unranked" : formatPosition(position);

const pad = (value: string | number, width: number): string =>
  String(value).padStart(width);

const padEnd = (value: string | number, width: number): string =>
  String(value).padEnd(width);

// ---------------------------------------------------------------------------
// The configuration
// ---------------------------------------------------------------------------
const seasonOne = createSeason({
  id: "2026-S1",
  name: "Season One",
  startsAt: SEASON_ONE_START,
  endsAt: SEASON_TWO_START,
});

const engine = new RankedEngine(
  createRankedConfig({
    // Glicko-2 is the default. Elo is a one-word change, and about
    // twenty-five times faster; see the README on which to pick.
    system: RatingSystem.Glicko2,
    season: seasonOne,
    placementMatches: 10,
    // A soft reset between seasons: halfway to the mean, with the uncertainty
    // widened so the first matches of the new season count for more. Nobody
    // starts from nothing; nobody keeps a place they cannot hold.
    reset: createSeasonResetConfig({ policy: ResetPolicy.Soft, pullPermille: 500 }),
  }),
);

// ---------------------------------------------------------------------------
// 1. Placements
// ---------------------------------------------------------------------------
line("1. Placements: ten matches, no visible rank");

let state: RankedState = createRankedState();
let now = SEASON_ONE_START + MINUTE_MS;

const placements: [number, MatchOutcome][] = [
  [1450, MatchOutcome.Win],
  [1520, MatchOutcome.Win],
  [1610, MatchOutcome.Loss],
  [1480, MatchOutcome.Win],
  [1560, MatchOutcome.Win],
  [1700, MatchOutcome.Loss],
  [1540, MatchOutcome.Win],
  [1590, MatchOutcome.Win],
  [1620, MatchOutcome.Win],
  [1650, MatchOutcome.Win],
];

for (const [opponentRating, outcome] of placements) {
  const result = engine.recordMatch(
    state,
    createRating({ rating: opponentRating, deviation: 90 }),
    outcome,
    now,
  );
  state = result.state;
  now += 30 * MINUTE_MS;

  if (result.inPlacements) {
    // What a placement screen shows: no rank yet, but the rating is moving and
    // the preview says where it is heading.
    console.log(
      `  match ${pad(state.seasonMatches, 2)}  ${padEnd(outcome, 5)}` +
        `  rating ${pad(state.rating.rating, 4)}` +
        `  (${result.placementsRemaining} to go)` +
        `  on track for ${formatPosition(engine.previewPosition(state))}`,
    );
  } else {
    console.log(
      `  match ${pad(state.seasonMatches, 2)}  ${padEnd(outcome, 5)}` +
        `  rating ${pad(state.rating.rating, 4)}` +
        `  -> placed at ${show(state.position)}`,
    );
  }
}

const [low, high] = ratingInterval(state.rating);
console.log(`\n  the system is 95 % sure the true skill is between ${low} and ${high}`);

// ---------------------------------------------------------------------------
// 2. Climbing
// ---------------------------------------------------------------------------
line("2. Climbing: the ladder moves in whole League Points");

for (let index = 0; index < 70; index += 1) {
  // A deliberately favourable run — four wins in five, against somebody the
  // player outclasses — so the example reaches a promotion series rather than
  // wandering. Only the outcome varies; the opponent is fixed.
  const outcome = index % 5 === 4 ? MatchOutcome.Loss : MatchOutcome.Win;
  const result = engine.recordMatch(
    state,
    createRating({ rating: 1400, deviation: 70 }),
    outcome,
    now,
  );
  state = result.state;
  now += 30 * MINUTE_MS;

  const change = result.ladder;
  if (change !== null && change.outcome !== "UNCHANGED" && change.outcome !== "FLOOR_HELD") {
    console.log(
      `  match ${pad(state.seasonMatches, 3)}  ${padEnd(change.outcome, 18)}` +
        `  ${formatPosition(change.current)}`,
    );
  }
}

console.log(`\n  now at ${show(state.position)}, rating ${state.rating.rating}`);
console.log(`  peak so far: ${show(state.peakPosition)}`);

// ---------------------------------------------------------------------------
// 3. A bad evening
// ---------------------------------------------------------------------------
line("3. A bad evening: floors and demotion protection");

for (let index = 0; index < 8; index += 1) {
  const result = engine.recordMatch(
    state,
    createRating({ rating: 1900, deviation: 70 }),
    MatchOutcome.Loss,
    now,
  );
  state = result.state;
  now += 20 * MINUTE_MS;
  const change = result.ladder;
  if (change !== null) {
    console.log(
      `  ${padEnd(change.outcome, 18)} ${pad(change.pointsDelta, 4)} LP` +
        `  -> ${formatPosition(change.current)}`,
    );
  }
}

console.log(`\n  the peak is kept: ${show(state.peakPosition)}`);
console.log("  rewards are based on that, not on where the season ends");

// ---------------------------------------------------------------------------
// 4. The season summary
// ---------------------------------------------------------------------------
line("4. The season summary");

const summary = engine.summarise(state);
console.log(`  season          ${summary.seasonId}`);
console.log(`  matches         ${summary.matchesPlayed}`);
console.log(`  W / L / D       ${summary.wins} / ${summary.losses} / ${summary.draws}`);
console.log(
  `  win rate        ${(
    (summary.wins * 1000) / Math.max(1, summary.wins + summary.losses) / 10
  ).toFixed(1)} %  (draws excluded)`,
);
console.log(`  peak rating     ${summary.peakRating}`);
console.log(`  final rating    ${summary.finalRating}`);
console.log(`  peak rank       ${show(summary.peakPosition)}`);
console.log(`  final rank      ${show(summary.finalPosition)}`);

// ---------------------------------------------------------------------------
// 5. Into the next season
// ---------------------------------------------------------------------------
line("5. Into the next season: soft, not brutal");

const seasonTwo = createSeason({
  id: "2026-S2",
  name: "Season Two",
  startsAt: SEASON_TWO_START,
});
const fresh = engine.startSeason(state, seasonTwo);

console.log(
  `  rating   ${state.rating.rating}  ->  ${fresh.rating.rating}   (halfway to 1500)`,
);
console.log(
  `  RD       ${pad(state.rating.deviation, 4)}  ->  ${pad(fresh.rating.deviation, 4)}` +
    "   (widened, so the first matches count for more)",
);
console.log(`  rank     ${show(state.position)}  ->  placements again`);
console.log("\n  A hard reset would send everybody to 1500 and make every player spend a");
console.log("  week playing strangers. A soft one lands a strong player high and lets");
console.log("  them confirm it in five matches.");

// ---------------------------------------------------------------------------
// 6. Storage
// ---------------------------------------------------------------------------
line("6. Storage: the caller owns the state");

const stored = JSON.stringify(serializeRankedState(state));
console.log(`  ${stored.length} bytes of JSON`);
console.log(`  ${stored.slice(0, 96)}...`);

if (JSON.stringify(deserializeRankedState(JSON.parse(stored))) !== JSON.stringify(state)) {
  throw new Error("the round trip lost something");
}
console.log("\n  round trip is exact, so a state can live in a database between matches");

// ---------------------------------------------------------------------------
// 7. Matchmaking
// ---------------------------------------------------------------------------
line("7. Matchmaking: is this a fair game?");

const candidates: [string, Rating][] = [
  ["an equal", createRating({ rating: state.rating.rating, deviation: 60 })],
  ["200 points below", createRating({ rating: state.rating.rating - 200, deviation: 60 })],
  ["600 points above", createRating({ rating: state.rating.rating + 600, deviation: 60 })],
  ["a total unknown", createRating({ rating: state.rating.rating, deviation: 350 })],
];

for (const [label, opponent] of candidates) {
  const quality = matchQuality(state.rating, opponent);
  const verdict = isAcceptable(quality, 400, 400) ? "run it" : "keep looking";
  console.log(
    `  ${padEnd(label, 18)} quality ${pad(quality.qualityPermille, 4)}` +
      `  win chance ${pad(quality.winProbabilityPermille, 4)}` +
      `  confident ${padEnd(String(quality.confident), 5)}  ${verdict}`,
  );
}

line("   and if you have six players, who plays with whom?");

const lobby = [1400, 1900, 1550, 1750, 1600, 1700].map((rating) =>
  createRating({ rating, deviation: 50 }),
);
const split = balanceTeams(lobby);
console.log(`  team A  [${split.left.map((index) => lobby[index]?.rating).join(", ")}]`);
console.log(`  team B  [${split.right.map((index) => lobby[index]?.rating).join(", ")}]`);
console.log(`  quality ${split.quality.qualityPermille}, gap ${split.quality.ratingGap}`);

console.log("\n  The library says how good a pairing is. Holding the queue is yours.\n");
