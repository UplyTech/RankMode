# Architecture

RankMode is one library in two editions, Python (`python/src/rankmode/`) and
TypeScript (`typescript/src/`). The editions must give the same answer for the
same input, down to the last unit.

## Shape of the library

Every public operation is a pure function of its arguments. State goes in, a new
state comes out; nothing is stored, logged or read from the environment. The
caller owns the database, the clock and the random source and hands them in.

```text
                caller (bot, service, game)
                        |  state, rule, now, random source
        +---------------+-----------------+
        |                                 |
  participation half               competition half
  engine       RankEngine          ranked       RankedEngine
  curves       threshold tables    rating       Elo, Glicko-2
  state        MemberState         ladder       tiers, divisions, series
  leaderboard  ranking, ties       season       resets between seasons
  migration    curve changes       matchmaking  fair games, team balance
        |                                 |
        +-------------- fixed ------------+
              deterministic exp, ln, sqrt on integers
```

## Modules

| Module | Responsibility |
|---|---|
| `engine` | Participation: awards, cooldowns, period caps, multipliers, levels |
| `curves` | Level thresholds, materialised as a table at construction |
| `state` | `MemberState` and its plain-dict / JSON form |
| `leaderboard` | Turning totals into a ranked list, with explicit tie handling |
| `migration` | Rewriting totals when a curve changes |
| `random_source` (Python), `random` (TypeScript) | Where the random span of an award comes from; the system source is the default, seeded and fixed sources are test helpers |
| `ranked` | The object a caller holds for competition: a match in, a new state out |
| `rating` | Elo and Glicko-2 |
| `ladder` | Mapping a rating onto a rank, League Points and promotion series |
| `season` | Seasonal soft resets |
| `matchmaking` | Match quality and team balancing (exhaustive, capped at 20 players) |
| `fixed` | Fixed-point `exp`, `ln` and `sqrt` on integers |
| `exact` (TypeScript only) | `floor(a * b / c)` exact beyond 2^53 |
| `errors` | `ValidationError` and the overflow errors |

## Design decisions

- **Integers only.** Levels, points and ratings are integers or fixed-point
  integers. A floating-point `exp` can differ by a bit between runtimes, and a
  bit is enough to disagree about a promotion.
- **Tables, not formulas.** A curve builds its threshold table once, so both
  editions look up the same numbers.
- **Safe range.** Totals stay inside the safe integer range of JavaScript.
  Intermediate products may not; `exact` handles those, and anything that would
  leave the range raises instead of wrapping.
- **Validation at the boundary.** Every state object a caller passes in is
  checked; a bad one raises `ValidationError` rather than misbehaving. States
  may come from a database an attacker can influence.
- **Bounded loops.** The volatility solver is the only unbounded-looking loop;
  it bisects within a clamped bracket, so its step count follows from the
  bracket width.
- **No I/O.** No sockets, files, logging or clock reads.

## How the editions are kept equal

1. `shared/testcases/` holds JSON vectors that both suites run.
2. `shared/tools/differential/` generates random cases, runs both editions and
   compares every result (see its README).
3. CI runs both on every pull request; the differential run uses a random seed
   nightly.

## Delivery

CI (`ci.yml`) tests both editions, enforces the coverage gate, lints,
type-checks and builds the packages. `release.yml` builds the npm tarball, wheel
and sdist on a `v*` tag, writes `SHA256SUMS` and a provenance statement, signs
each file and publishes after approval. Security checks run in `security.yml`,
`codeql.yml`, `dependency-review.yml` and `scorecard.yml`.
