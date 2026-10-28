# rankmode

> Two ways of ranking people. Experience points and levels for taking part; ratings, ladders and seasons for winning. Pure calculation: no storage, no platform binding, no display.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)
[![Python](https://img.shields.io/badge/python-%3E%3D3.10-blue)](https://python.org)

This is the Python edition. A [TypeScript edition](../typescript) exists and
produces identical results — proven by [shared test vectors](../shared/testcases).

## Install

```bash
pip install uplytech-rankmode
```

Zero mandatory dependencies. Python 3.10 or newer.

## Quick start

```python
from rankmode import RankEngine, create_event_rule, create_member_state

engine = RankEngine(
    rules=[
        create_event_rule("message", 15, 25, cooldown_seconds=60, period_cap_xp=1000),
    ]
)

state = create_member_state()                                  # or load yours
result = engine.award(state, "message", now=1_700_000_000_000)

print(result.outcome)        # AwardOutcome.AWARDED
print(result.awarded_xp)     # somewhere between 15 and 25
print(result.new_total_xp)
print(result.leveled_up)
state = result.state         # store this
```

`now` is epoch **milliseconds** and is always passed in — the library never
reads the clock, so your cooldowns stay testable.

## The engine

```python
RankEngine(
    curve=QuadraticCurve(base=100, max_level=1000),  # default
    rules=[...],
    default_rule=None,        # used for event types no rule matches
    global_cap=None,          # a ceiling across all event types together
    decay=None,               # optional XP decay
    allow_negative=False,     # let totals go below zero
    max_total_xp=MAX_TOTAL_XP,
)
```

| Method | Returns |
|---|---|
| `award(state, event_type, now, multipliers=(), random_source=None, base_xp=None)` | `AwardResult` |
| `penalize(state, amount, now, reset_cooldown_for=())` | `AwardResult` |
| `apply_decay(state, now)` | `AwardResult` |
| `progress(total_xp)` | `LevelProgress` |
| `level_for(total_xp)` | `int` |
| `can_award(state, event_type, now)` | `bool` |
| `cooldown_remaining_ms(state, event_type, now)` | `int` |
| `period_remaining_xp(state, event_type, now)` | `int \| None` |
| `estimate_time_to_level(total_xp, target_level, xp_per_hour)` | `int` (ms) |
| `rule_for(event_type)` | `EventRule \| None` |

Every one of them leaves the state you passed untouched. The new state is in
`result.state`.

## Outcomes, not exceptions

A blocked award is a normal event, not an error:

```python
from rankmode import AwardOutcome

match engine.award(state, "message", now=now).outcome:
    case AwardOutcome.AWARDED:       ...
    case AwardOutcome.COOLDOWN:      ...   # happens constantly
    case AwardOutcome.PERIOD_CAP:    ...   # happens daily
    case AwardOutcome.RULE_DISABLED: ...
    case AwardOutcome.UNKNOWN_EVENT: ...
    case AwardOutcome.NO_XP:         ...   # e.g. a 0-multiplier channel
```

Exceptions are for programming mistakes:

| Exception | Raised when |
|---|---|
| `ConfigurationError` | a curve, rule or engine option is impossible |
| `ValidationError` | a call-site argument is wrong (negative amount, non-integer `now`) |
| `CurveError` | a level outside the curve was asked for |
| `MigrationError` | an unknown migration strategy |

All derive from `RankModeError` and carry a stable `.code` plus `.details`, so
you never have to compare message texts.

## Curves

```python
from rankmode import LinearCurve, QuadraticCurve, ExponentialCurve, TabularCurve

QuadraticCurve(base=100)                            # default: 100, 300, 600, 1000, ...
LinearCurve(base=100)                               # 100, 200, 300, ...
ExponentialCurve(base=100, growth_permille=1500)    # each level costs 1.5x the last
TabularCurve([0, 10, 50, 500, 5000])                # your own thresholds
```

`growth_permille` is an integer: `1500` means factor 1.5. Everything in this
library that could be a float is a permille integer instead, so that the Python
and TypeScript editions cannot drift through rounding.

Quadratic is the default because linear devalues long-standing members and
exponential frustrates newcomers. See the [root README](../README.md#the-four-curves).

## Level cards

```python
p = engine.progress(state.total_xp)

p.level               # 9
p.xp_into_level       # 200
p.level_span          # 1000
p.xp_to_next          # 800
p.progress_permille   # 200   (0..1000, integer)
p.progress_ratio      # 0.2   (float, display only)
p.is_max_level        # False
```

## Leaderboards

```python
from rankmode import TieMode, build_leaderboard, rank_of

rows = [("ana", 5000), ("ben", 12000), ("cai", 5000)]      # from your database
board = build_leaderboard(engine.curve, rows, tie_mode=TieMode.COMPETITION)

for entry in board:
    print(entry.rank, entry.member_id, entry.level, entry.total_xp)

rank_of("ana", rows)     # 2, without building the whole board
```

Fetch and sort in your database (`ORDER BY total_xp DESC LIMIT 100`); hand the
page to RankMode for the ranking. Ties keep input order — see the root README
for why that is not a tie-break on the member id.

## Persistence

```python
import json
from rankmode import serialize_member_state, deserialize_member_state

json.dumps(serialize_member_state(state))        # -> store in a JSONB column
deserialize_member_state(json.loads(raw))        # -> back again
```

The serialised field names (`totalXp`, `lastEventAt`, ...) are the same in both
editions, so a bot ported from Python to TypeScript keeps its data.

Keep a denormalised `total_xp` column next to the JSON so leaderboards stay a
`ORDER BY`, and only write when `result.changed` is true — the blocked-cooldown
case is the common one and needs no write at all.

## Randomness

```python
from rankmode import SystemRandomSource, SeededRandomSource, FixedRandomSource

engine.award(state, "message", now=now)                                # crypto by default
engine.award(state, "message", now=now, random_source=SeededRandomSource(42))   # tests
engine.award(state, "message", now=now, random_source=FixedRandomSource([20]))  # tests
```

> **Production must use `SystemRandomSource`** — the default. A predictable
> generator lets anyone who works out the algorithm predict the next award,
> which is exactly the farming the random span exists to prevent.

## Changing the curve later

```python
from rankmode import MigrationStrategy, preview_migration, migrate_all

report = preview_migration(all_totals, old_curve, new_curve)
if report.safe_for_members:
    new_totals = [r.new_total_xp for r in migrate_all(all_totals, old_curve, new_curve)]
```

Always preview first. A curve change is a major version because it moves every
member's level.

## The ranked half

Everything above ranks *participation*. This ranks *winning*: a rating, a place
on a ladder, and a season that starts again without starting from nothing.

```python
from rankmode import (
    MatchOutcome, RankedConfig, RankedEngine, Rating, Season,
    create_ranked_state, format_position, serialize_ranked_state,
)

season = Season(id="2026-S1", name="Season One", starts_at=1_767_225_600_000)
engine = RankedEngine(RankedConfig(season=season))

state = create_ranked_state()
result = engine.record_match(
    state,
    Rating(rating=1520, deviation=90),
    MatchOutcome.WIN,
    now=1_767_311_000_000,
)

if result.in_placements:
    print(f"{result.placements_remaining} placement matches to go")
else:
    print(format_position(result.state.position))   # "Gold II, 47 LP"
    print(result.ladder.outcome)                    # PROMOTED_DIVISION, ...

store(serialize_ranked_state(result.state))
```

`record_match` never touches the state you hand it. Everything about the match
comes back on the result: what the rating did, what the ladder did, how likely
the player was to win, and the streak.

### Ratings

```python
from rankmode import (
    Glicko2Config, MatchOutcome, Rating, RatingSystem,
    expected_score_permille, rating_interval, update_glicko2,
)

player = Rating(rating=1500, deviation=200)
opponent = Rating(rating=1700, deviation=60)

expected_score_permille(player, opponent)     # 244 -- a one-in-four chance
rating_interval(player)                       # (1108, 1892) -- 95 % sure

# Glicko-2 is defined over a rating period, not a match. A caller who updates
# per match passes one result and gets the same behaviour, slightly noisier.
update_glicko2(player, [
    (Rating(rating=1400, deviation=30), MatchOutcome.WIN),
    (Rating(rating=1550, deviation=100), MatchOutcome.LOSS),
])

# An empty period is the case Glicko-2 has an answer for that Elo does not:
# no rating change, and a *wider* deviation, because the system knows less
# than it did.
update_glicko2(player, [])
```

Switch to Elo with `RankedConfig(system=RatingSystem.ELO)`. It is about
twenty-five times faster and knows nothing about uncertainty; the trade is
described in the [root README](../README.md#elo-or-glicko-2).

### The ladder

```python
from rankmode import (
    Division, LadderConfig, Tier, apply_league_points,
    compare_positions, format_position, position_for_rating,
)

position_for_rating(1586)                  # Gold II, 48 LP
format_position(position_for_rating(3100)) # "Challenger, 200 LP"

change = apply_league_points(position, won=True, rating=1586)
change.outcome        # UNCHANGED, PROMOTED_DIVISION, SERIES_STARTED, ...
change.points_delta   # signed, and never zero for a decided match

# Sort a leaderboard by rank rather than by rating.
sorted(positions, key=cmp_to_key(compare_positions), reverse=True)
```

The rating and the ladder are deliberately two numbers. A player whose rating
says Platinum while their bracket says Gold gains more per win and loses less
per loss, and so climbs to where they belong in a few matches instead of a few
dozen. That adjustment is the entire reason for keeping them apart.

Every threshold, every point value and every rule is on `LadderConfig`:
promotion series can be switched off, tier demotion can be switched off, and a
`tier_floor` stops the fall at a tier once it is reached.

### Seasons

```python
from rankmode import ResetPolicy, Season, SeasonResetConfig, season_for

# The reset is soft by default: halfway to the mean, with the uncertainty
# widened so the first few matches of the new season count for more.
config = RankedConfig(
    season=season,
    reset=SeasonResetConfig(policy=ResetPolicy.SOFT, pull_permille=500),
)

# record_match resets a state from an old season on its own. Do it explicitly
# when you have a leaderboard, which is wrong until everybody has been reset.
fresh = engine.start_season(state, next_season)

summary = engine.summarise(state)
summary.peak_position       # what a reward should be based on
summary.win_rate_permille   # draws excluded from the denominator
```

Nothing here reads a clock. `season_for(seasons, timestamp)` answers which
season a moment falls in, and `None` between two seasons is a normal answer.

### Matchmaking

```python
from rankmode import balance_teams, is_acceptable, match_quality, team_rating

quality = match_quality(player, opponent)
quality.quality_permille    # 1000 is a coin toss between two certain players
quality.confident           # False when the system is guessing about either

is_acceptable(quality, minimum_quality_permille=400, maximum_gap=300)

split = balance_teams([p1, p2, p3, p4, p5, p6])   # indices, not players
split.left, split.right
```

The library does not run a queue. Holding the pool of waiting players and
deciding when to widen the search belongs to the caller, who already has them in
memory.

## Examples

```bash
PYTHONPATH=src python examples/basic.py
PYTHONPATH=src python examples/discord_bot_integration.py
PYTHONPATH=src python examples/ranked_season.py
```

The second shows the seam a Discord bot needs: where the database sits, where
policy (channel and role multipliers) lives, and where the library stops.

The third plays a whole competitive season — placements, the climb, a promotion
series, a bad evening, the summary and the reset into the next season. Run its
TypeScript twin and diff the two outputs: 81 of 87 lines are byte-identical, and
the six that are not are `json.dumps` whitespace and a capital `True`.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest --cov=rankmode     # 738 tests, 98.5 % coverage
.venv/bin/python -m mypy                      # strict
.venv/bin/python -m ruff check .
```

## License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

Copyright (c) 2021-present UplyTech. UplyTech has existed as a community since 2021.
