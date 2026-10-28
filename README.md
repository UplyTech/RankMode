# RankMode

> Two ways of ranking people, in one library. Experience points and levels for taking part; ratings, ladders and seasons for winning. Calculated, never stored — one formula, one behaviour, everywhere UplyTech ranks anything.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/UplyTech/RankMode/badge)](https://scorecard.dev/viewer/?uri=github.com/UplyTech/RankMode)
[![Python](https://img.shields.io/badge/python-%3E%3D3.10-blue)](./python)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)](./typescript)

---

## What it does, in two sentences

**Participation:** RankMode turns "this member did something" into "here is
their new total, their new level, and whether they just levelled up".

**Competition:** it turns "this player won that match" into "here is their new
rating, their new rank, and whether they just got promoted".

Two halves, one library, because they are the same question asked twice and a
community that wants both should not run two sets of arithmetic.

| | Participation | Competition |
|---|---|---|
| **Question** | who takes part? | who is better? |
| **Engine** | `RankEngine` | `RankedEngine` |
| **Input** | an event happened | a match ended |
| **Output** | total XP, a level, a progress bar | a rating, a tier and division, League Points |
| **Goes up when** | you show up | you win |
| **Goes down when** | you stop showing up (decay) | you lose |
| **Reset** | never | every season, softly |
| **Five-minute tour** | [participation](#five-minutes) | [competition](#five-more-minutes-the-ranked-half) |

You can use either half alone. They share the errors, the determinism rules and
the shared test vectors, and nothing else.

## What it deliberately does not do

This list is as important as the feature list, because it is what keeps the same
library usable for a Discord bot, a forum and a website at once:

| Not in scope | Who does it instead |
|---|---|
| **Storing anything** | You. RankMode takes the current state in and hands a new one back. |
| **Talking to Discord** | Your bot. RankMode has never heard of a message, a role or a channel. |
| **Drawing level cards** | Your bot. RankMode gives you the numbers; the picture is yours. |
| **Granting rewards** | Your bot. RankMode reports the level-up; the role is your decision. |
| **Currency, and everything economic on top of it** | [EconomyWorld](../EconomyWorld) — balances, shops, trading, banking, credit, markets and billing. Points are recognition; a balance is purchasing power. |
| **Activity statistics** | SawStats. |
| **Deciding *when* to calculate** | Your scheduler. |
| **Running a matchmaking queue** | Your bot. RankMode says how good a pairing is and how to split a group into teams; holding the pool of waiting players and deciding when to widen the search is yours. |
| **Deciding when a season ends** | Your scheduler. A season boundary is a timestamp you pass in — a library that read the clock could not be tested. |

## Two editions, one behaviour

| Edition | Package | Status |
|---|---|---|
| **Python** | [`rankmode`](./python) | primary — all current callers are Python bots |
| **TypeScript** | [`@uplytech/rankmode`](./typescript) | for forums, websites and Node bots |

Both editions produce **identical results for identical inputs**, and it is
checked two ways.

[`shared/testcases/`](./shared/testcases) holds vectors that both suites run.
Those catch a regression in something somebody already thought of — which is
exactly what they did not do for the three divergences fixed in 2.0.0, because
every vector worked below 10⁶ and every divergence appeared only above 2⁵³.

So [`shared/tools/differential/`](./shared/tools/differential) generates the
cases nobody thought of: random configurations and call sequences across the
full magnitude range, answered by both editions and compared. It runs on every
pull request with a fixed seed, and nightly with a random one.

A difference in either edition turns into a red build, not into two communities
whose members hold different levels for the same activity.

```text
              shared/testcases/*.json
             (curves, awards, leaderboard,
              migration, multipliers, random)
                    /              \
                   /                \
        python/tests/          typescript/tests/
     test_shared_vectors.py   shared-vectors.test.ts
```

## Install

```bash
# Python
pip install uplytech-rankmode

# TypeScript / JavaScript
npm install @uplytech/rankmode
```

> **Not on npm or PyPI yet.** The first release is pending the Trusted Publisher setup on both registries. Until then, build from a clone (see [CONTRIBUTING.md](./CONTRIBUTING.md)) or use the signed artefacts of a [GitHub release](https://github.com/UplyTech/RankMode/releases) once one exists.

Neither edition has a single mandatory dependency.

## Five minutes

```python
from rankmode import RankEngine, create_event_rule, create_member_state

engine = RankEngine(
    rules=[create_event_rule("message", 15, 25, cooldown_seconds=60, period_cap_xp=1000)]
)

state = load_from_your_database(member_id) or create_member_state()   # your code
result = engine.award(state, "message", now=now_in_epoch_millis())

if result.changed:
    save_to_your_database(member_id, result.state)                    # your code
if result.leveled_up:
    await announce(f"Level {result.new_level}!")                      # your code
```

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

const state = (await loadFromYourDatabase(memberId)) ?? createMemberState();
const result = engine.award(state, "message", { now: Date.now() });

if (result.changed) await saveToYourDatabase(memberId, result.state);
if (result.leveledUp) await announce(`Level ${result.newLevel}!`);
```

The full, runnable versions live in
[`python/examples/`](./python/examples) and
[`typescript/examples/`](./typescript/examples).

## Five more minutes: the ranked half

```python
from rankmode import (
    MatchOutcome, RankedConfig, RankedEngine, Rating, Season,
    create_ranked_state, format_position,
)

season = Season(id="2026-S1", name="Season One", starts_at=1_767_225_600_000)
engine = RankedEngine(RankedConfig(season=season))

state = create_ranked_state()          # a player who has never played ranked
opponent = Rating(rating=1520, deviation=90)

result = engine.record_match(state, opponent, MatchOutcome.WIN, now=1_767_311_000_000)

if result.in_placements:
    print(f"{result.placements_remaining} placement matches to go")
    print(f"on track for {format_position(engine.preview_position(result.state))}")
else:
    print(format_position(result.state.position))     # "Gold II, 47 LP"
    print(result.ladder.outcome)                      # PROMOTED_DIVISION, SERIES_STARTED, ...

store(result.state)                    # the input state was not touched
```

```typescript
import {
  createRankedState, createSeason, formatPosition, MatchOutcome,
  RankedEngine, createRankedConfig, createRating,
} from "@uplytech/rankmode";

const season = createSeason({ id: "2026-S1", name: "Season One", startsAt: 1_767_225_600_000 });
const engine = new RankedEngine(createRankedConfig({ season }));

const result = engine.recordMatch(
  createRankedState(),
  createRating({ rating: 1520, deviation: 90 }),
  MatchOutcome.Win,
  1_767_311_000_000,
);
```

### What the ranked half decides for you

Every one of these is a decision that reads as a bug when it is made the obvious
way, which is why the library makes it rather than leaving it to each caller:

| | What happens | Why |
|---|---|---|
| **Placements** | ten matches with no visible rank; the rating moves the whole time | showing somebody Bronze after one loss is how a ladder loses a player on their first evening |
| **Rating vs. rank** | two separate numbers | the matchmaker gets to be honest while the display gets to be kind |
| **Under-ranked players** | gain more per win, lose less per loss | so they climb to where they belong in a few matches instead of a few dozen |
| **Leaving a tier** | a best-of-five promotion series | one lucky match should not move somebody into a bracket they cannot hold |
| **Failing a series** | drop to 75 LP, not to zero | it should cost something without erasing the climb |
| **Demotion after promotion** | blocked for three matches | otherwise a promotion at 0 LP is undone by the next loss |
| **Falling out of a tier** | land at 75 LP, not 99 | bouncing on a tier boundary every other match is the worst experience a ladder has |
| **A draw** | moves the rating, not the ladder | splitting a League Point in half is worse than not moving |
| **A new season** | rating pulled halfway to the mean, uncertainty widened | nobody starts from nothing, and nobody keeps a place they can no longer hold |
| **Rewards** | based on the *peak*, not the final standing | basing them on the final standing teaches players to stop once they hit their target |
| **Not playing** | the deviation widens on its own | which is why a returning player's first matches count for more, and why there is no separate "rust" rule |

### Elo or Glicko-2

**Glicko-2 is the default.** It carries how *sure* the system is, so an uncertain
player moves fast, a settled one moves slowly, and a player who stops playing
becomes uncertain again on their own. Elo treats a player who has played four
matches exactly like one who has played four hundred; the K-factor schedule
papers over that, it does not fix it.

Pick Elo when you need a number a player can compute in their head, or when your
scope is small enough that uncertainty never settles.

| | Elo | Glicko-2 |
|---|---|---|
| Numbers per player | 1 | 3 |
| Knows how sure it is | no | yes |
| Handles inactivity | no | yes, by itself |
| Cost per match | ~2 µs | ~50 µs |
| Reference | Elo's chess work | Glickman's paper, worked example reproduced digit for digit |

The Glicko-2 cost is the volatility solve: two dozen bisection steps, each
evaluating an exact integer `exp`. That is the price of two editions agreeing to
the last unit. Twenty thousand ranked matches a second on one core is the
ceiling, which is far past any load a ladder sees.

### The tiers

Nine, because that is what a population of any size needs — fewer and the middle
is a single enormous bucket where nobody can see progress, more and the names
stop meaning anything.

| Tier | Default rating | Divisions |
|---|---|---|
| Iron | 0 | IV, III, II, I |
| Bronze | 800 | IV, III, II, I |
| Silver | 1100 | IV, III, II, I |
| Gold | 1400 | IV, III, II, I |
| Platinum | 1700 | IV, III, II, I |
| Diamond | 2000 | IV, III, II, I |
| Master | 2300 | — |
| Grandmaster | 2600 | — |
| Challenger | 2900 | — |

The top three are **apex tiers**: no divisions, and the League Points are an
open-ended ladder score rather than a bracket. Every threshold, every division
count and every point value is configurable.

### Why the arithmetic is integer

A rating system needs `exp`, `ln` and `sqrt`. Both editions could call the ones
their runtime provides, and both would be right to within a bit or two — which
is exactly the problem. IEEE 754 pins down the four basic operations to the last
bit and does **not** pin down the transcendental ones, so a rating landing one
micro-unit either side of a promotion threshold is a player promoted in one
edition and not in the other.

So `rankmode.fixed` / `src/fixed.ts` computes them on integers instead, in
micro-units, with an algorithm that has no freedom to differ. It is public: use
it if you need the same guarantee for arithmetic of your own.

## The four curves

A curve maps a total onto a level. Three are generated, one is yours.

| Curve | Level cost | Suits |
|---|---|---|
| `LinearCurve` | constant | small servers, short seasons |
| **`QuadraticCurve`** *(default)* | grows evenly | the usual case |
| `ExponentialCurve` | multiplied each level | large, long-running communities |
| `TabularCurve` | whatever you supply | season passes, inherited tables |

**Quadratic is the default, and the reason is written down.** Linear devalues
long-standing members, because newcomers catch up too easily. Exponential
frustrates newcomers, because progress stalls early. Quadratic keeps both in a
workable relation — that is the kind of experience a shared library can hold and
four separate copies lose.

```text
QuadraticCurve(base=100):   level 1 = 100     level 2 = 300     level 3 = 600
                            level 4 = 1000    level 5 = 1500    ...
                            total(L) = base * L * (L + 1) / 2
```

Every curve materialises a threshold table at construction rather than
evaluating a formula on demand. That is what makes "identical in both editions"
provable instead of likely.

## Abuse resistance is a feature, not an add-on

Point systems get farmed. Reliably. Three mechanisms ship in the core:

| Mechanism | What it stops |
|---|---|
| **Random span** | Fixed values invite members to compute the exact rate and farm it. |
| **Cooldown per member and event type** | Whoever types fastest would otherwise win. |
| **Period caps, per rule and across all rules** | Puts a ceiling on a day, however creative the member is. |

A blocked award is **not** an exception. It comes back as an outcome:

```python
result = engine.award(state, "message", now=now)
match result.outcome:
    case AwardOutcome.AWARDED:     ...
    case AwardOutcome.COOLDOWN:    ...   # normal, happens constantly
    case AwardOutcome.PERIOD_CAP:  ...   # normal, happens daily
```

Exceptions are reserved for programming mistakes: a broken curve, an impossible
rule, a total outside the safe range.

### The cooldown does not restart when it blocks

A blocked attempt leaves the timestamp alone. Otherwise a member who spams
during their cooldown would keep pushing it forward and never earn again — a
bug that is easy to write and hard to notice.

## Two things are handed in, never taken

```python
engine.award(state, "message", now=..., random_source=...)
```

**Time** and **randomness** are parameters, not ambient state. A library that
reads the system clock cannot have its cooldowns tested, and a library with a
built-in random generator cannot have its awards tested. In production you pass
the real ones; in tests you pass predictable ones.

> **In production, use the cryptographic source** (`SystemRandomSource` /
> `CryptoRandomSource`). A member who knows the algorithm behind a predictable
> generator can predict the next award — which is exactly the farming the random
> span exists to prevent.

## Leaderboards: ties, and why input order decides them

```python
board = build_leaderboard(engine.curve, rows, tie_mode=TieMode.COMPETITION)
```

| Tie mode | Numbering |
|---|---|
| `COMPETITION` *(default)* | 1, 2, 2, 4 — the usual sports ranking |
| `DENSE` | 1, 2, 2, 3 — no gaps |
| `ORDINAL` | 1, 2, 3, 4 — every row its own number |

Members on the same total keep the order they were handed in. Breaking ties on
the member id would have been the obvious choice and would have been a bug:
Python compares strings by code point, JavaScript by UTF-16 code unit, and the
two disagree for characters outside the basic plane. The editions must never
disagree.

**RankMode ranks; it does not fetch.** Sorting a hundred thousand rows belongs
in the database that already holds them. Select your page, hand it over, get
back the part that is easy to get wrong.

## Changing the curve later

A curve change moves the level of every member in the community. It is the most
disruptive thing an operator can do, which is why it is **always a major
version** — and why the migration tools are part of the library rather than an
afterthought:

```python
report = preview_migration(all_totals, old_curve, new_curve)
print(report.safe_for_members)   # the number the community owner asks for
print(report.lost_levels, report.max_loss)
```

| Strategy | Effect |
|---|---|
| `PRESERVE_PROGRESS` *(default)* | level **and** progress bar survive the switch |
| `PRESERVE_LEVEL` | level survives, the bar resets to empty |
| `PRESERVE_XP` | the raw total survives, levels move — only for a fresh scope |

Run the preview before switching. A curve change without a preview produces
complaints.

## Quality bar

Both editions are held to the same numbers, which are stricter than the general
UplyTech package standard because a wrong formula here is wrong in every calling
bot at once:

| | Python | TypeScript |
|---|---|---|
| Tests | 738 | 548 |
| Coverage | 98.5 % | 98.9 % |
| Mandatory dependencies | 0 | 0 |
| Type checking | `mypy --strict`, source **and tests** | `tsc --noEmit`, source **and tests** |
| Linting | `ruff` clean | `eslint` clean |
| Cross-edition agreement | shared vectors **and a differential fuzzer** | shared vectors **and a differential fuzzer** |

The cross-edition agreement is the number that matters most, and it is checked
three ways: 2,243 fixed ranked vectors plus the participation ones, a sweep of
24,905 values through every ranked function in both editions, and a differential
fuzzer over ten case kinds. The fuzzer has found a real defect in both editions
at once — see the 3.0.0 changelog — which is the whole reason it exists.

```bash
# Python
cd python && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest --cov=rankmode

# TypeScript
cd typescript && npm install && npm test && npm run typecheck && npm run lint
```

## Repository layout

```text
RankMode/
├── README.md                 # you are here
├── CHANGELOG.md              # one history for both editions
├── CONTRIBUTING.md           # how to change a curve without breaking a community
├── SECURITY.md
├── LICENSE                   # Apache-2.0
├── NOTICE
├── shared/testcases/         # the contract between the editions
├── shared/tools/differential/# the fuzzer that finds what the vectors miss
├── python/                   # the primary edition
│   ├── src/rankmode/
│   │   ├── engine.py         # participation: XP, levels, cooldowns, caps
│   │   ├── curves.py  state.py  leaderboard.py  migration.py
│   │   ├── ranked.py         # competition: the engine a caller holds
│   │   ├── rating.py         # Elo and Glicko-2
│   │   ├── ladder.py         # tiers, divisions, League Points, series
│   │   ├── season.py         # seasons and soft resets
│   │   ├── matchmaking.py    # match quality and team balancing
│   │   └── fixed.py          # deterministic exp, ln, sqrt on integers
│   ├── tests/
│   └── examples/
├── typescript/               # the second edition
│   ├── src/
│   ├── tests/
│   ├── examples/
│   └── scripts/generate-shared-vectors.mjs
└── .github/                  # CI, release, and the settings it assumes
```

## Versioning

Semantic, and shared: both editions carry the same version number. The rules
that matter to a caller:

| Change | Bump |
|---|---|
| Bug fix, no behaviour change | patch |
| New curve, new rule kind, new option | minor |
| **Any change to a curve's numbers** | **major** — it moves every member's level |
| **Any change to a rating or ladder formula** | **major** — it moves every player's rank |
| Removal or behaviour change | major, deprecated one minor beforehand |

## Documentation

- [Python edition](./python/README.md)
- [TypeScript edition](./typescript/README.md)
- [Shared test vectors](./shared/testcases/README.md)
- [Differential harness](./shared/tools/differential/README.md) — how the two editions are held to each other
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Changelog](./CHANGELOG.md)

## Security and OpenSSF

- **CI** runs on GitHub-hosted runners (`ci.yml`, `quality.yml`, `docs.yml`, `security.yml`, `nightly.yml`). The repository is public and the organisation runner serves private repositories only; for public repositories the hosted minutes are free. Pull requests are validated with a read-only token and without secrets; no workflow uses `pull_request_target`. Every action is pinned to a full commit SHA.
- **OpenSSF Scorecard** runs weekly and on every push to `main` (`scorecard.yml`) and publishes its result; the badge at the top shows the current score.
- **CodeQL** (`codeql.yml`) and **dependency review** on pull requests (`dependency-review.yml`) run on every change.
- **OpenSSF Best Practices badge** (bestpractices.dev): pending owner registration.
- **Supply chain**: Dependabot for npm, pip, Docker and GitHub Actions (weekly, minor and patch grouped), gitleaks and OSV scans on a schedule, [SECURITY.md](./SECURITY.md) with private reporting.
- **Not achievable here**: with a single maintainer the Scorecard checks for code review and contributors stay low.

### Releases and how to verify them

A release is created from a `v*` tag by `release.yml`: tests, build, signature, the GitHub release, then the registries. The registry jobs run in the environment `release`, which accepts only `v*` tags and waits for the owner's approval, and use Trusted Publishing (OIDC), so no long-lived registry token exists. Each registry is switched on separately with the repository variables `PUBLISH_NPM` and `PUBLISH_PYPI` once its Trusted Publisher is configured ([.github/SETTINGS.md](./.github/SETTINGS.md)); without them a tag still produces the signed GitHub release. Only a tag on a commit that is on `main` is released.

- **npm**: `@uplytech/rankmode`, published with `npm publish --provenance`. Check with `npm audit signatures` or on the package page ("Built and signed on GitHub Actions").
- **PyPI**: `uplytech-rankmode`, published with `pypa/gh-action-pypi-publish` (PEP 740 attestations included).
- **GitHub release**: the same artefacts (npm tarball, wheel, sdist), `SHA256SUMS`, an in-toto SLSA provenance statement (`provenance.intoto.json`) and one UplyTech signature per file (`<file>.sig`, base64 of an ECDSA P-256 / SHA-256 signature).

```bash
# 1. UplyTech signature (public key: release-signing.pub in this repository)
base64 -d <file>.sig > <file>.sig.der
openssl dgst -sha256 -verify release-signing.pub -signature <file>.sig.der <file>
sha256sum -c SHA256SUMS --ignore-missing

# 2. GitHub build attestation
gh attestation verify <file> --repo UplyTech/RankMode
```

The signing key is the organisation secret `RELEASE_SIGNING_KEY`; the release job fails when it is empty instead of publishing unsigned files.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright (c) 2021-present UplyTech. UplyTech has existed as a community since 2021.
