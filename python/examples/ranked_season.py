"""A whole competitive season, in one runnable file.

    PYTHONPATH=src python examples/ranked_season.py

Everything the ranked half does, in the order a caller meets it: placements,
seeding, climbing, a promotion series, demotion protection, a season summary and
the reset into the next season. Nothing here reads a clock or a random source -
the timestamps are arguments and the results are a fixed list, so this file
prints the same thing every time it is run.

It also prints the same thing as ``typescript/examples/ranked-season.ts``: 81 of
its 87 lines are byte-identical, and the six that are not are ``json.dumps``
putting a space after a colon and Python spelling ``True`` with a capital. Every
number matches. That is the whole promise of this library, in a form you can
check by running both and diffing the output.
"""

from __future__ import annotations

import json

from rankmode import (
    LadderPosition,
    MatchOutcome,
    RankedConfig,
    RankedEngine,
    RankedState,
    Rating,
    RatingSystem,
    ResetPolicy,
    Season,
    SeasonResetConfig,
    balance_teams,
    create_ranked_state,
    deserialize_ranked_state,
    format_position,
    is_acceptable,
    match_quality,
    rating_interval,
    serialize_ranked_state,
)


def where(position: LadderPosition | None) -> str:
    """A position as text. ``None`` means placements are still running."""
    return "unranked" if position is None else format_position(position)


MINUTE_MS = 60_000
DAY_MS = 24 * 60 * MINUTE_MS
SEASON_ONE_START = 1_767_225_600_000  # 1 January 2026
SEASON_TWO_START = SEASON_ONE_START + 90 * DAY_MS


def line(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


# ---------------------------------------------------------------------------
# The configuration
# ---------------------------------------------------------------------------
season_one = Season(
    id="2026-S1",
    name="Season One",
    starts_at=SEASON_ONE_START,
    ends_at=SEASON_TWO_START,
)

engine = RankedEngine(
    RankedConfig(
        # Glicko-2 is the default. Elo is a one-word change, and about
        # twenty-five times faster; see the README on which to pick.
        system=RatingSystem.GLICKO2,
        season=season_one,
        placement_matches=10,
        # A soft reset between seasons: halfway to the mean, with the
        # uncertainty widened so the first matches of the new season count for
        # more. Nobody starts from nothing; nobody keeps a place they cannot
        # hold.
        reset=SeasonResetConfig(policy=ResetPolicy.SOFT, pull_permille=500),
    )
)


# ---------------------------------------------------------------------------
# 1. Placements
# ---------------------------------------------------------------------------
line("1. Placements: ten matches, no visible rank")

state: RankedState = create_ranked_state()
now = SEASON_ONE_START + MINUTE_MS

placement_results = [
    (1450, MatchOutcome.WIN),
    (1520, MatchOutcome.WIN),
    (1610, MatchOutcome.LOSS),
    (1480, MatchOutcome.WIN),
    (1560, MatchOutcome.WIN),
    (1700, MatchOutcome.LOSS),
    (1540, MatchOutcome.WIN),
    (1590, MatchOutcome.WIN),
    (1620, MatchOutcome.WIN),
    (1650, MatchOutcome.WIN),
]

for opponent_rating, outcome in placement_results:
    result = engine.record_match(
        state, Rating(rating=opponent_rating, deviation=90), outcome, now
    )
    state = result.state
    now += 30 * MINUTE_MS

    if result.in_placements:
        # What a placement screen shows: no rank yet, but the rating is moving
        # and the preview says where it is heading.
        print(
            f"  match {state.season_matches:>2}  {outcome.value:<5}"
            f"  rating {state.rating.rating:>4}"
            f"  ({result.placements_remaining} to go)"
            f"  on track for {where(engine.preview_position(state))}"
        )
    else:
        print(
            f"  match {state.season_matches:>2}  {outcome.value:<5}"
            f"  rating {state.rating.rating:>4}"
            f"  -> placed at {where(state.position)}"
        )

low, high = rating_interval(state.rating)
print(f"\n  the system is 95 % sure the true skill is between {low} and {high}")


# ---------------------------------------------------------------------------
# 2. Climbing
# ---------------------------------------------------------------------------
line("2. Climbing: the ladder moves in whole League Points")

for index in range(70):
    # A deliberately favourable run - four wins in five, against somebody the
    # player outclasses - so the example reaches a promotion series rather than
    # wandering. Only the outcome varies; the opponent is fixed.
    outcome = MatchOutcome.LOSS if index % 5 == 4 else MatchOutcome.WIN
    result = engine.record_match(state, Rating(rating=1400, deviation=70), outcome, now)
    state = result.state
    now += 30 * MINUTE_MS

    change = result.ladder
    if change is not None and change.outcome.value not in ("UNCHANGED", "FLOOR_HELD"):
        print(
            f"  match {state.season_matches:>3}  {change.outcome.value:<18}"
            f"  {where(change.current)}"
        )

print(f"\n  now at {where(state.position)}, rating {state.rating.rating}")
print(f"  peak so far: {where(state.peak_position)}")


# ---------------------------------------------------------------------------
# 3. A bad evening
# ---------------------------------------------------------------------------
line("3. A bad evening: floors and demotion protection")

for _ in range(8):
    result = engine.record_match(
        state, Rating(rating=1900, deviation=70), MatchOutcome.LOSS, now
    )
    state = result.state
    now += 20 * MINUTE_MS
    change = result.ladder
    if change is not None:
        print(
            f"  {change.outcome.value:<18} {change.points_delta:>4} LP"
            f"  -> {where(change.current)}"
        )

print(f"\n  the peak is kept: {where(state.peak_position)}")
print("  rewards are based on that, not on where the season ends")


# ---------------------------------------------------------------------------
# 4. The season summary
# ---------------------------------------------------------------------------
line("4. The season summary")

summary = engine.summarise(state)
print(f"  season          {summary.season_id}")
print(f"  matches         {summary.matches_played}")
print(f"  W / L / D       {summary.wins} / {summary.losses} / {summary.draws}")
print(f"  win rate        {summary.win_rate_permille / 10:.1f} %  (draws excluded)")
print(f"  peak rating     {summary.peak_rating}")
print(f"  final rating    {summary.final_rating}")
print(f"  peak rank       {where(summary.peak_position)}")
print(f"  final rank      {where(summary.final_position)}")


# ---------------------------------------------------------------------------
# 5. Into the next season
# ---------------------------------------------------------------------------
line("5. Into the next season: soft, not brutal")

season_two = Season(id="2026-S2", name="Season Two", starts_at=SEASON_TWO_START)
fresh = engine.start_season(state, season_two)

print(f"  rating   {state.rating.rating}  ->  {fresh.rating.rating}   (halfway to 1500)")
print(
    f"  RD       {state.rating.deviation:>4}  ->  {fresh.rating.deviation:>4}"
    "   (widened, so the first matches count for more)"
)
print(f"  rank     {where(state.position)}  ->  placements again")
print("\n  A hard reset would send everybody to 1500 and make every player spend a")
print("  week playing strangers. A soft one lands a strong player high and lets")
print("  them confirm it in five matches.")


# ---------------------------------------------------------------------------
# 6. Storage
# ---------------------------------------------------------------------------
line("6. Storage: the caller owns the state")

stored = json.dumps(serialize_ranked_state(state))
print(f"  {len(stored)} bytes of JSON")
print(f"  {stored[:96]}...")

assert deserialize_ranked_state(json.loads(stored)) == state
print("\n  round trip is exact, so a state can live in a database between matches")


# ---------------------------------------------------------------------------
# 7. Matchmaking
# ---------------------------------------------------------------------------
line("7. Matchmaking: is this a fair game?")

candidates = [
    ("an equal", Rating(rating=state.rating.rating, deviation=60)),
    ("200 points below", Rating(rating=state.rating.rating - 200, deviation=60)),
    ("600 points above", Rating(rating=state.rating.rating + 600, deviation=60)),
    ("a total unknown", Rating(rating=state.rating.rating, deviation=350)),
]

for label, opponent in candidates:
    quality = match_quality(state.rating, opponent)
    verdict = "run it" if is_acceptable(quality, 400, 400) else "keep looking"
    print(
        f"  {label:<18} quality {quality.quality_permille:>4}"
        f"  win chance {quality.win_probability_permille:>4}"
        f"  confident {str(quality.confident):<5}  {verdict}"
    )

line("   and if you have six players, who plays with whom?")

lobby = [
    Rating(rating=1400, deviation=50),
    Rating(rating=1900, deviation=50),
    Rating(rating=1550, deviation=50),
    Rating(rating=1750, deviation=50),
    Rating(rating=1600, deviation=50),
    Rating(rating=1700, deviation=50),
]
split = balance_teams(lobby)
print(f"  team A  {[lobby[i].rating for i in split.left]}")
print(f"  team B  {[lobby[i].rating for i in split.right]}")
print(f"  quality {split.quality.quality_permille}, gap {split.quality.rating_gap}")

print("\n  The library says how good a pairing is. Holding the queue is yours.\n")
