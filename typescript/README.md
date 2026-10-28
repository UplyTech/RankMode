# @uplytech/rankmode

> Two ways of ranking people. Experience points and levels for taking part; ratings, ladders and seasons for winning. Pure calculation: no storage, no platform binding, no display.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

This is the TypeScript edition. A [Python edition](../python) exists and produces
identical results — proven by [shared test vectors](../shared/testcases).

## Install

```bash
npm install @uplytech/rankmode
# or
pnpm add @uplytech/rankmode
# or
yarn add @uplytech/rankmode
```

Zero runtime dependencies. Node 20 or newer. Ships CJS, ESM and types.

## Quick start

```typescript
import { RankEngine, createEventRule, createMemberState } from "@uplytech/rankmode";

const engine = new RankEngine({
  rules: [
    createEventRule({
      eventType: "message",
      minXp: 15,
      maxXp: 25,
      cooldownSeconds: 60,
      periodCapXp: 1000,
    }),
  ],
});

let state = createMemberState();               // or load yours
const result = engine.award(state, "message", { now: Date.now() });

result.outcome;      // "AWARDED"
result.awardedXp;    // somewhere between 15 and 25
result.newTotalXp;
result.leveledUp;
state = result.state; // store this
```

`now` is epoch **milliseconds** and is always passed in — the library never reads
the clock, so your cooldowns stay testable.

## The engine

```typescript
new RankEngine({
  curve: new QuadraticCurve({ base: 100, maxLevel: 1000 }), // default
  rules: [],
  defaultRule: null,   // used for event types no rule matches
  globalCap: null,     // a ceiling across all event types together
  decay: null,         // optional XP decay
  allowNegative: false,
  maxTotalXp: MAX_TOTAL_XP,
});
```

| Method | Returns |
|---|---|
| `award(state, eventType, { now, multipliers?, random?, baseXp? })` | `AwardResult` |
| `penalize(state, amount, { now, resetCooldownFor? })` | `AwardResult` |
| `applyDecay(state, { now })` | `AwardResult` |
| `progress(totalXp)` | `LevelProgress` |
| `levelFor(totalXp)` | `number` |
| `canAward(state, eventType, now)` | `boolean` |
| `cooldownRemainingMs(state, eventType, now)` | `number` |
| `periodRemainingXp(state, eventType, now)` | `number \| null` |
| `estimateTimeToLevel(totalXp, targetLevel, xpPerHour)` | `number` (ms) |
| `ruleFor(eventType)` | `EventRule \| null` |

Every one of them leaves the state you passed untouched. The new state is in
`result.state`.

## Outcomes, not exceptions

A blocked award is a normal event, not an error:

```typescript
import { AwardOutcome } from "@uplytech/rankmode";

switch (result.outcome) {
  case AwardOutcome.Awarded:      break;
  case AwardOutcome.Cooldown:     break;  // happens constantly
  case AwardOutcome.PeriodCap:    break;  // happens daily
  case AwardOutcome.RuleDisabled: break;
  case AwardOutcome.UnknownEvent: break;
  case AwardOutcome.NoXp:         break;  // e.g. a 0-multiplier channel
}
```

Exceptions are for programming mistakes:

| Error | Thrown when |
|---|---|
| `ConfigurationError` | a curve, rule or engine option is impossible |
| `ValidationError` | a call-site argument is wrong (negative amount, non-finite `now`) |
| `CurveError` | a level outside the curve was asked for |
| `MigrationError` | an unknown migration strategy |

All extend `RankModeError` and carry a stable `.code` plus frozen `.details`, so
you never have to compare message texts.

## Curves

```typescript
import {
  LinearCurve, QuadraticCurve, ExponentialCurve, TabularCurve,
} from "@uplytech/rankmode";

new QuadraticCurve({ base: 100 });                          // 100, 300, 600, 1000, ...
new LinearCurve({ base: 100 });                             // 100, 200, 300, ...
new ExponentialCurve({ base: 100, growthPermille: 1500 });  // each level costs 1.5x
new TabularCurve([0, 10, 50, 500, 5000]);                   // your own thresholds
```

`growthPermille` is an integer: `1500` means factor 1.5. Everything in this
library that could be a float is a permille integer instead, so that the two
editions cannot drift through rounding.

Quadratic is the default because linear devalues long-standing members and
exponential frustrates newcomers. See the [root README](../README.md#the-four-curves).

## Level cards

```typescript
const p = engine.progress(state.totalXp);

p.level;              // 9
p.xpIntoLevel;        // 200
p.levelSpan;          // 1000
p.xpToNext;           // 800
p.progressPermille;   // 200   (0..1000, integer)
p.isMaxLevel;         // false
```

## Leaderboards

```typescript
import { buildLeaderboard, rankOf, TieMode } from "@uplytech/rankmode";

const rows = [
  { memberId: "ana", totalXp: 5000 },
  { memberId: "ben", totalXp: 12_000 },
  { memberId: "cai", totalXp: 5000 },
];

const board = buildLeaderboard(engine.curve, rows, { tieMode: TieMode.Competition });
rankOf("ana", rows); // 2, without building the whole board
```

Fetch and sort in your database (`ORDER BY total_xp DESC LIMIT 100`); hand the
page to RankMode for the ranking. Ties keep input order — see the root README
for why that is not a tie-break on the member id.

## Persistence

```typescript
import { serializeMemberState, deserializeMemberState } from "@uplytech/rankmode";

JSON.stringify(serializeMemberState(state));   // -> store in a JSONB column
deserializeMemberState(JSON.parse(raw));       // -> back again
```

The serialised field names are the same in both editions, so a bot ported
between them keeps its data.

Keep a denormalised `total_xp` column next to the JSON so leaderboards stay an
`ORDER BY`, and only write when `result.changed` — the blocked-cooldown
case is the common one and needs no write at all.

## Randomness

```typescript
import {
  CryptoRandomSource, SeededRandomSource, FixedRandomSource,
} from "@uplytech/rankmode";

engine.award(state, "message", { now });                                    // crypto by default
engine.award(state, "message", { now, random: new SeededRandomSource(42) }); // tests
engine.award(state, "message", { now, random: new FixedRandomSource([20]) });// tests
```

> **Production must use `CryptoRandomSource`** — the default. A predictable
> generator lets anyone who works out the algorithm predict the next award,
> which is exactly the farming the random span exists to prevent.

## Changing the curve later

```typescript
import { previewMigration, migrateAll } from "@uplytech/rankmode";

const report = previewMigration(allTotals, oldCurve, newCurve);
if (report.safeForMembers) {
  const newTotals = migrateAll(allTotals, oldCurve, newCurve).map((r) => r.newTotalXp);
}
```

Always preview first. A curve change is a major version because it moves every
member's level.

## The ranked half

Everything above ranks *participation*. This ranks *winning*: a rating, a place
on a ladder, and a season that starts again without starting from nothing.

```typescript
import {
  createRankedConfig, createRankedState, createRating, createSeason,
  formatPosition, MatchOutcome, RankedEngine, serializeRankedState,
} from "@uplytech/rankmode";

const season = createSeason({
  id: "2026-S1",
  name: "Season One",
  startsAt: 1_767_225_600_000,
});
const engine = new RankedEngine(createRankedConfig({ season }));

const result = engine.recordMatch(
  createRankedState(),
  createRating({ rating: 1520, deviation: 90 }),
  MatchOutcome.Win,
  1_767_311_000_000,
);

if (result.inPlacements) {
  console.log(`${result.placementsRemaining} placement matches to go`);
} else {
  console.log(formatPosition(result.state.position!));  // "Gold II, 47 LP"
  console.log(result.ladder?.outcome);                  // PROMOTED_DIVISION, ...
}

store(serializeRankedState(result.state));
```

`recordMatch` never touches the state you hand it. Everything about the match
comes back on the result: what the rating did, what the ladder did, how likely
the player was to win, and the streak.

### Ratings

```typescript
import {
  createRating, expectedScorePermille, MatchOutcome,
  ratingInterval, RatingSystem, updateGlicko2,
} from "@uplytech/rankmode";

const player = createRating({ rating: 1500, deviation: 200 });
const opponent = createRating({ rating: 1700, deviation: 60 });

expectedScorePermille(player, opponent);   // 244 — a one-in-four chance
ratingInterval(player);                    // [1108, 1892] — 95 % sure

// Glicko-2 is defined over a rating period, not a match.
updateGlicko2(player, [
  [createRating({ rating: 1400, deviation: 30 }), MatchOutcome.Win],
  [createRating({ rating: 1550, deviation: 100 }), MatchOutcome.Loss],
]);

// An empty period is the case Glicko-2 has an answer for that Elo does not:
// no rating change, and a *wider* deviation.
updateGlicko2(player, []);
```

Switch to Elo with `createRankedConfig({ system: RatingSystem.Elo })`. It is
about twenty-five times faster and knows nothing about uncertainty; the trade is
described in the [root README](../README.md#elo-or-glicko-2).

### The ladder

```typescript
import {
  applyLeaguePoints, comparePositions, Division, formatPosition,
  positionForRating, Tier,
} from "@uplytech/rankmode";

positionForRating(1586);                    // Gold II, 48 LP
formatPosition(positionForRating(3100));    // "Challenger, 200 LP"

const change = applyLeaguePoints(position, true, 1586);
change.outcome;        // Unchanged, PromotedDivision, SeriesStarted, ...
change.pointsDelta;    // signed, and never zero for a decided match

positions.sort(comparePositions).reverse();
```

The rating and the ladder are deliberately two numbers. A player whose rating
says Platinum while their bracket says Gold gains more per win and loses less
per loss, and so climbs to where they belong in a few matches instead of a few
dozen. That adjustment is the entire reason for keeping them apart.

Every threshold, every point value and every rule is on the ladder config:
promotion series can be switched off, tier demotion can be switched off, and a
`tierFloor` stops the fall at a tier once it is reached.

### Seasons

```typescript
import {
  createSeasonResetConfig, createSeason, ResetPolicy, seasonFor,
} from "@uplytech/rankmode";

// The reset is soft by default: halfway to the mean, with the uncertainty
// widened so the first few matches of the new season count for more.
const config = createRankedConfig({
  season,
  reset: createSeasonResetConfig({ policy: ResetPolicy.Soft, pullPermille: 500 }),
});

// recordMatch resets a state from an old season on its own. Do it explicitly
// when you have a leaderboard, which is wrong until everybody has been reset.
const fresh = engine.startSeason(state, nextSeason);

const summary = engine.summarise(state);
summary.peakPosition;   // what a reward should be based on
```

Nothing here reads a clock. `seasonFor(seasons, timestamp)` answers which season
a moment falls in, and `null` between two seasons is a normal answer.

### Matchmaking

```typescript
import { balanceTeams, isAcceptable, matchQuality, teamRating } from "@uplytech/rankmode";

const quality = matchQuality(player, opponent);
quality.qualityPermille;   // 1000 is a coin toss between two certain players
quality.confident;         // false when the system is guessing about either

isAcceptable(quality, 400, 300);

const split = balanceTeams([p1, p2, p3, p4, p5, p6]);  // indices, not players
split.left, split.right;
```

The library does not run a queue. Holding the pool of waiting players and
deciding when to widen the search belongs to the caller, who already has them in
memory.

## Examples

```bash
npm run examples        # all three of the below
npx vite-node examples/basic.ts
npx vite-node examples/discord-bot-integration.ts
npx vite-node examples/ranked-season.ts
```

The second shows the seam a Discord bot needs: where the database sits, where
policy (channel and role multipliers) lives, and where the library stops.

The third plays a whole competitive season — placements, the climb, a promotion
series, a bad evening, the summary and the reset into the next season. Run its
Python twin and diff the two outputs: 81 of 87 lines are byte-identical, and the
six that are not are `json.dumps` whitespace and a capital `True`.

## Development

```bash
npm install
npm test                # 548 tests
npm run test:coverage   # 98.9 % coverage, gate at 95 %
npm run typecheck
npm run lint
npm run build

# regenerate the cross-edition vectors (deliberate act -- see CONTRIBUTING.md)
node scripts/generate-shared-vectors.mjs
```

## License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

Copyright (c) 2021-present UplyTech. UplyTech has existed as a community since 2021.
