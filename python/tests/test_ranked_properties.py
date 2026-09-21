"""The ranked system's invariants, stated as invariants.

The sibling of ``test_properties.py``, for the competitive half. The rest of the
ranked suite pins down specific numbers, which is the right way to test a
formula. It is the wrong way to test a *rule*: "a ladder position never comes
back with negative points" is true of every input, and six examples of it prove
six inputs.

Two of the defects this half of the library was built with would have been found
here rather than by hand. The volatility solver's two-cycle and the deviation
decay's fixed point are both failures of a stated property - "the iteration
terminates" and "an idle period widens the deviation" - and neither is visible
in any single example.
"""

from __future__ import annotations

from hypothesis import HealthCheck, assume, given, settings
from hypothesis import strategies as st

from rankmode import (
    Division,
    Glicko2Config,
    LadderConfig,
    LadderOutcome,
    LadderPosition,
    MatchOutcome,
    RankedConfig,
    RankedEngine,
    Rating,
    RatingSystem,
    ResetPolicy,
    Season,
    SeasonResetConfig,
    Tier,
    apply_league_points,
    balance_teams,
    compare_positions,
    create_ranked_state,
    deserialize_ranked_state,
    expected_score_permille,
    match_quality,
    position_for_rating,
    rating_for_position,
    reset_rating,
    serialize_ranked_state,
    team_rating,
    update_elo,
    update_glicko2,
)

LADDER = LadderConfig()
GLICKO = Glicko2Config()

ratings = st.builds(
    Rating,
    rating=st.integers(min_value=0, max_value=5000),
    deviation=st.integers(min_value=1, max_value=350),
    volatility=st.integers(min_value=1_000, max_value=500_000),
    matches_played=st.integers(min_value=0, max_value=5000),
)

outcomes = st.sampled_from(list(MatchOutcome))
systems = st.sampled_from(list(RatingSystem))
tiers = st.sampled_from(list(Tier))


@st.composite
def positions(draw: st.DrawFn) -> LadderPosition:
    tier = draw(tiers)
    if tier.is_apex:
        return LadderPosition(
            tier=tier,
            division=None,
            league_points=draw(st.integers(min_value=0, max_value=5000)),
        )
    return LadderPosition(
        tier=tier,
        division=draw(st.sampled_from(list(Division))),
        league_points=draw(st.integers(min_value=0, max_value=99)),
    )


# ---------------------------------------------------------------------------
# Ratings
# ---------------------------------------------------------------------------


@given(ratings, ratings, systems)
def test_expected_score_is_always_a_probability(
    player: Rating, opponent: Rating, system: RatingSystem
) -> None:
    assert 0 <= expected_score_permille(player, opponent, system) <= 1000


@given(ratings, ratings)
def test_elo_expectations_of_the_two_sides_add_up(player: Rating, opponent: Rating) -> None:
    forward = expected_score_permille(player, opponent, RatingSystem.ELO)
    backward = expected_score_permille(opponent, player, RatingSystem.ELO)
    # Off by one at most: two independent roundings of the same number.
    assert abs(forward + backward - 1000) <= 1


@given(ratings, ratings)
def test_glicko2_expectations_add_up_when_both_sides_are_equally_known(
    player: Rating, opponent: Rating
) -> None:
    """Glicko-2's expectation is asymmetric on purpose.

    ``E(A, B)`` damps by *B's* deviation and ``E(B, A)`` by *A's*, so the two
    directions are different questions and are not required to sum to one. They
    are only complementary when the system is equally sure about both sides,
    which is what this checks - and it is the reason ``match_quality`` fixes an
    evaluation order rather than trusting the two directions to agree.
    """
    same = Rating(
        rating=opponent.rating,
        deviation=player.deviation,
        volatility=opponent.volatility,
        matches_played=opponent.matches_played,
    )
    forward = expected_score_permille(player, same, RatingSystem.GLICKO2)
    backward = expected_score_permille(same, player, RatingSystem.GLICKO2)
    assert abs(forward + backward - 1000) <= 1


@given(ratings, ratings, outcomes)
def test_elo_stays_inside_its_bounds(
    player: Rating, opponent: Rating, outcome: MatchOutcome
) -> None:
    after = update_elo(player, opponent, outcome)
    assert 0 <= after.rating <= 5000
    assert after.matches_played == player.matches_played + 1
    # Elo has no opinion about either, so it must leave both alone.
    assert after.deviation == player.deviation
    assert after.volatility == player.volatility


@given(ratings, ratings, outcomes)
def test_glicko2_stays_inside_its_bounds(
    player: Rating, opponent: Rating, outcome: MatchOutcome
) -> None:
    after = update_glicko2(player, [(opponent, outcome)])
    assert GLICKO.floor <= after.rating <= GLICKO.ceiling
    assert GLICKO.min_deviation <= after.deviation <= GLICKO.max_deviation
    assert GLICKO.min_volatility <= after.volatility <= GLICKO.max_volatility
    assert after.matches_played == player.matches_played + 1


@given(ratings, ratings, outcomes)
def test_neither_system_ever_raises(
    player: Rating, opponent: Rating, outcome: MatchOutcome
) -> None:
    """The property the volatility solver used to violate.

    Its bracket ran past the domain where the fixed-point ``exp`` is defined,
    and 816 of 4800 inputs in one sweep raised. No single example test would
    have found it: the inputs that trigger it are the improbable ones.
    """
    update_elo(player, opponent, outcome)
    update_glicko2(player, [(opponent, outcome)])
    update_glicko2(player, [])


@given(ratings)
def test_an_idle_period_always_widens_the_deviation(player: Rating) -> None:
    """The property the decay used to violate.

    Past 109 one period's growth rounded back to the number it started from, so
    the deviation had a fixed point and an idle player stopped becoming
    unknown. True of every starting point below the cap, and of no example.
    """
    assume(player.deviation < GLICKO.max_deviation)
    after = update_glicko2(player, [])
    assert after.deviation > player.deviation
    assert after.rating == player.rating


@given(ratings, ratings)
def test_a_win_never_lowers_the_rating_and_a_loss_never_raises_it(
    player: Rating, opponent: Rating
) -> None:
    assume(GLICKO.floor < player.rating < GLICKO.ceiling)
    assert update_glicko2(player, [(opponent, MatchOutcome.WIN)]).rating >= player.rating
    assert update_glicko2(player, [(opponent, MatchOutcome.LOSS)]).rating <= player.rating


@given(ratings, ratings, outcomes)
def test_updates_are_deterministic(
    player: Rating, opponent: Rating, outcome: MatchOutcome
) -> None:
    assert update_elo(player, opponent, outcome) == update_elo(player, opponent, outcome)
    assert update_glicko2(player, [(opponent, outcome)]) == update_glicko2(
        player, [(opponent, outcome)]
    )


# ---------------------------------------------------------------------------
# The ladder
# ---------------------------------------------------------------------------


@given(st.integers(min_value=0, max_value=5000))
def test_every_rating_maps_to_a_valid_position(rating: int) -> None:
    position = position_for_rating(rating, LADDER)
    assert position.league_points >= 0
    assert position.tier.is_apex == (position.division is None)
    if not position.tier.is_apex:
        assert position.league_points < LADDER.points_per_division


@given(st.integers(min_value=0, max_value=5000), st.integers(min_value=0, max_value=5000))
def test_seeding_preserves_the_ordering_of_ratings(left: int, right: int) -> None:
    ordering = (left > right) - (left < right)
    seeded = compare_positions(
        position_for_rating(left, LADDER), position_for_rating(right, LADDER)
    )
    # Two ratings in the same bracket seed equal; otherwise the order is kept.
    assert seeded == 0 or seeded == ordering


@given(positions())
def test_a_bracket_round_trips_through_its_rating(position: LadderPosition) -> None:
    # Above apex the points *are* the rating, one for one, so a Master on 300
    # points is standing exactly on Grandmaster's threshold and round-trips
    # into it. That is the mapping working, not failing, so the property is
    # stated for positions that are inside their own tier.
    if position.tier.is_apex:
        index = position.tier.order
        thresholds = LADDER.tier_thresholds
        span = (
            thresholds[index + 1] - thresholds[index]
            if index + 1 < len(thresholds)
            else 10_000
        )
        assume(position.league_points < span)

    recovered = position_for_rating(rating_for_position(position, LADDER), LADDER)
    assert recovered.tier is position.tier
    assert recovered.division is position.division


@given(positions(), st.booleans(), st.integers(0, 5000), st.integers(0, 1000))
def test_a_match_never_produces_an_impossible_position(
    position: LadderPosition, won: bool, rating: int, since: int
) -> None:
    change = apply_league_points(position, won, rating, LADDER, since)
    assert change.current.league_points >= 0
    assert change.current.tier.is_apex == (change.current.division is None)
    # A tier moves by at most one step per match, in either direction.
    assert abs(change.current.tier.order - position.tier.order) <= 1


@given(positions(), st.booleans(), st.integers(0, 5000), st.integers(0, 1000))
def test_a_match_is_never_worth_nothing(
    position: LadderPosition, won: bool, rating: int, since: int
) -> None:
    # Except during a series, where points deliberately do not move.
    change = apply_league_points(position, won, rating, LADDER, since)
    if change.outcome not in (
        LadderOutcome.SERIES_ADVANCED,
        LadderOutcome.SERIES_FAILED,
        LadderOutcome.PROMOTED_TIER,
    ):
        assert change.points_delta != 0


@given(positions(), st.booleans(), st.integers(0, 5000))
def test_the_input_position_is_never_mutated(
    position: LadderPosition, won: bool, rating: int
) -> None:
    before = (position.tier, position.division, position.league_points, position.series)
    apply_league_points(position, won, rating, LADDER, 999)
    assert (
        position.tier,
        position.division,
        position.league_points,
        position.series,
    ) == before


@given(positions(), positions())
def test_comparison_is_antisymmetric(left: LadderPosition, right: LadderPosition) -> None:
    assert compare_positions(left, right) == -compare_positions(right, left)


@given(positions(), positions(), positions())
def test_comparison_is_transitive(
    a: LadderPosition, b: LadderPosition, c: LadderPosition
) -> None:
    if compare_positions(a, b) >= 0 and compare_positions(b, c) >= 0:
        assert compare_positions(a, c) >= 0


# ---------------------------------------------------------------------------
# Seasons
# ---------------------------------------------------------------------------


@given(
    ratings,
    st.sampled_from(list(ResetPolicy)),
    st.integers(min_value=0, max_value=1000),
)
def test_a_reset_never_produces_an_invalid_rating(
    player: Rating, policy: ResetPolicy, pull: int
) -> None:
    after = reset_rating(player, SeasonResetConfig(policy=policy, pull_permille=pull))
    assert after.deviation > 0
    assert after.volatility > 0
    assert after.matches_played >= 0


@given(
    st.integers(min_value=0, max_value=5000),
    st.integers(min_value=0, max_value=5000),
    st.integers(min_value=0, max_value=1000),
)
def test_a_soft_reset_compresses_without_reordering(left: int, right: int, pull: int) -> None:
    assume(left <= right)
    config = SeasonResetConfig(pull_permille=pull)
    after_left = reset_rating(Rating(rating=left), config).rating
    after_right = reset_rating(Rating(rating=right), config).rating
    assert after_left <= after_right


@given(st.integers(min_value=0, max_value=1500), st.integers(min_value=0, max_value=1000))
def test_a_reset_is_symmetric_about_the_mean(distance: int, pull: int) -> None:
    config = SeasonResetConfig(pull_permille=pull)
    up = reset_rating(Rating(rating=1500 + distance), config).rating - 1500
    down = 1500 - reset_rating(Rating(rating=1500 - distance), config).rating
    assert up == down


# ---------------------------------------------------------------------------
# Matchmaking
# ---------------------------------------------------------------------------


@given(ratings, ratings, systems)
def test_quality_is_always_a_permille(
    left: Rating, right: Rating, system: RatingSystem
) -> None:
    quality = match_quality(left, right, system)
    assert 0 <= quality.quality_permille <= 1000
    assert 0 <= quality.win_probability_permille <= 1000


@given(ratings, ratings, systems)
def test_quality_is_symmetric(left: Rating, right: Rating, system: RatingSystem) -> None:
    assert (
        match_quality(left, right, system).quality_permille
        == match_quality(right, left, system).quality_permille
    )


@given(st.lists(ratings, min_size=1, max_size=10))
def test_a_team_rating_is_always_usable(members: list[Rating]) -> None:
    team = team_rating(members)
    assert team.deviation >= 1
    assert team.volatility >= 1
    assert min(m.rating for m in members) <= team.rating <= max(m.rating for m in members)


@given(st.lists(ratings, min_size=1, max_size=5))
def test_balancing_uses_every_player_exactly_once(members: list[Rating]) -> None:
    players = members * 2  # guaranteed even, and at most ten
    split = balance_teams(players)
    assert sorted([*split.left, *split.right]) == list(range(len(players)))
    assert len(split.left) == len(split.right)


# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------

SEASON = Season(id="S1", name="One", starts_at=0, ends_at=10_000_000)


@settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.tuples(ratings, outcomes), min_size=1, max_size=60), systems)
def test_a_season_of_any_shape_stays_consistent(
    matches: list[tuple[Rating, MatchOutcome]], system: RatingSystem
) -> None:
    engine = RankedEngine(RankedConfig(system=system, season=SEASON, placement_matches=10))
    state = create_ranked_state()

    for index, (opponent, outcome) in enumerate(matches):
        result = engine.record_match(state, opponent, outcome, index * 60_000)
        state = result.state

        assert state.wins + state.losses + state.draws == state.season_matches == index + 1
        assert state.peak_rating >= state.rating.rating
        assert 0 <= state.rating.rating <= 5000
        assert state.matches_since_promotion >= 0
        assert (state.position is None) == result.in_placements
        if state.position is not None:
            assert state.position.league_points >= 0
            assert state.position.tier.is_apex == (state.position.division is None)
            assert state.peak_position is not None
            assert compare_positions(state.peak_position, state.position) >= 0


@settings(max_examples=50, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.tuples(ratings, outcomes), min_size=0, max_size=40))
def test_a_state_survives_a_round_trip_at_every_point(
    matches: list[tuple[Rating, MatchOutcome]],
) -> None:
    """The property a caller relies on but never states.

    Nobody keeps a state in memory between matches; they store it and load it
    back. A state that does not survive that is a ladder that quietly forgets
    somebody's promotion series.
    """
    engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=10))
    state = create_ranked_state()
    for index, (opponent, outcome) in enumerate(matches):
        state = engine.record_match(state, opponent, outcome, index * 60_000).state
        assert deserialize_ranked_state(serialize_ranked_state(state)) == state


@settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.tuples(ratings, outcomes), min_size=1, max_size=40))
def test_storing_between_matches_changes_nothing(
    matches: list[tuple[Rating, MatchOutcome]],
) -> None:
    engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=10))

    straight = create_ranked_state()
    stored = create_ranked_state()
    for index, (opponent, outcome) in enumerate(matches):
        straight = engine.record_match(straight, opponent, outcome, index * 60_000).state
        stored = deserialize_ranked_state(serialize_ranked_state(stored))
        stored = engine.record_match(stored, opponent, outcome, index * 60_000).state

    assert serialize_ranked_state(stored) == serialize_ranked_state(straight)
