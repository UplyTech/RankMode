"""The ranked engine: the one object a caller actually holds."""

from __future__ import annotations

import json
from typing import Any

import pytest

from rankmode import (
    ConfigurationError,
    Division,
    LadderOutcome,
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
    SeriesState,
    Tier,
    ValidationError,
    clone_ranked_state,
    create_ranked_state,
    deserialize_ranked_state,
    serialize_ranked_state,
)

MINUTE = 60_000
SEASON = Season(id="S1", name="One", starts_at=0, ends_at=10_000_000)


def make_rating(
    rating: int, deviation: int = 80, volatility: int = 60_000, played: int = 0
) -> Rating:
    return Rating(
        rating=rating, deviation=deviation, volatility=volatility, matches_played=played
    )


def play(
    engine: RankedEngine,
    state: RankedState,
    outcomes: list[MatchOutcome],
    opponent: Rating | None = None,
    start: int = 0,
) -> RankedState:
    """Run a sequence of matches and return the final state."""
    current = state
    for index, outcome in enumerate(outcomes):
        current = engine.record_match(
            current,
            opponent if opponent is not None else make_rating(1500),
            outcome,
            start + index * MINUTE,
        ).state
    return current


class TestConfig:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"placement_matches": -1},
            {"streak_threshold": -1},
            {"streak_bonus_points": -1},
            {"max_streak_bonus": -1},
        ],
    )
    def test_refuses_impossible_configuration(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ConfigurationError):
            RankedConfig(**kwargs)

    def test_defaults_to_glicko2(self) -> None:
        assert RankedConfig().system is RatingSystem.GLICKO2

    def test_a_ladder_can_have_no_seasons_at_all(self) -> None:
        # A valid choice for a small community.
        assert RankedConfig().season is None


class TestState:
    def test_a_new_player_has_no_rank_yet(self) -> None:
        state = create_ranked_state()
        assert state.position is None
        assert state.season_matches == 0
        assert state.peak_rating == state.rating.rating
        assert state.last_match_at is None

    def test_can_start_from_a_known_rating(self) -> None:
        state = create_ranked_state(make_rating(2000, 50))
        assert state.rating.rating == 2000
        assert state.peak_rating == 2000

    def test_cloning_copies_everything(self) -> None:
        original = create_ranked_state(make_rating(1800))
        original.position = LadderPosition(
            tier=Tier.GOLD, division=Division.TWO, league_points=40
        )
        original.wins = 7
        copy = clone_ranked_state(original)
        assert copy == original
        copy.wins = 99
        assert original.wins == 7


class TestPlacements:
    def test_no_rank_is_shown_until_they_are_finished(self) -> None:
        # Showing somebody Bronze after one loss is how a ladder loses a player
        # on their first evening.
        engine = RankedEngine(RankedConfig(placement_matches=10))
        state = create_ranked_state()
        for index in range(9):
            result = engine.record_match(
                state, make_rating(1500), MatchOutcome.LOSS, index * MINUTE
            )
            state = result.state
            assert result.in_placements is True
            assert state.position is None
            assert result.placements_remaining == 9 - index

    def test_the_rating_still_moves_during_them(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=10))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 5)
        assert state.rating.rating > 1500

    def test_the_rank_is_seeded_from_the_rating_when_they_end(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=10))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 10)
        assert state.position is not None
        seeded = engine.preview_position(state)
        assert state.position.tier is seeded.tier
        assert state.position.division is seeded.division

    def test_winning_the_placements_seeds_higher_than_losing_them(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=10))
        won = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 10, make_rating(1800))
        lost = play(engine, create_ranked_state(), [MatchOutcome.LOSS] * 10, make_rating(1800))
        assert won.position is not None and lost.position is not None
        assert won.position.tier.order >= lost.position.tier.order
        assert won.rating.rating > lost.rating.rating

    def test_the_preview_works_during_placements(self) -> None:
        # The "you are on track for ..." line a placement screen shows.
        engine = RankedEngine(RankedConfig(placement_matches=10))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 3)
        assert engine.position_of(state) is None
        assert engine.preview_position(state) is not None

    def test_placements_can_be_switched_off(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        result = engine.record_match(
            create_ranked_state(), make_rating(1500), MatchOutcome.WIN, 0
        )
        assert result.in_placements is False
        assert result.state.position is not None

    def test_a_freshly_seeded_player_is_protected_from_demotion(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=10))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 10)
        assert state.matches_since_promotion == 0


class TestRecordMatch:
    def test_counts_the_outcome(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        state = play(
            engine,
            create_ranked_state(),
            [MatchOutcome.WIN, MatchOutcome.WIN, MatchOutcome.LOSS, MatchOutcome.DRAW],
        )
        assert (state.wins, state.losses, state.draws) == (2, 1, 1)
        assert state.season_matches == 4

    def test_records_when_the_match_happened(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        result = engine.record_match(
            create_ranked_state(), make_rating(1500), MatchOutcome.WIN, 12_345_678
        )
        assert result.state.last_match_at == 12_345_678

    def test_reports_the_chance_the_player_had(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        favourite = engine.record_match(
            create_ranked_state(make_rating(2500)), make_rating(1000), MatchOutcome.WIN, 0
        )
        underdog = engine.record_match(
            create_ranked_state(make_rating(1000)), make_rating(2500), MatchOutcome.WIN, 0
        )
        assert favourite.expected_permille > 800
        assert underdog.expected_permille < 200

    def test_never_mutates_the_state_it_is_given(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        state = create_ranked_state()
        before = clone_ranked_state(state)
        engine.record_match(state, make_rating(1500), MatchOutcome.WIN, 0)
        assert state == before

    def test_refuses_a_non_integer_timestamp(self) -> None:
        engine = RankedEngine()
        with pytest.raises(ValidationError):
            engine.record_match(
                create_ranked_state(),
                make_rating(1500),
                MatchOutcome.WIN,
                1.5,  # type: ignore[arg-type]
            )

    def test_works_under_elo_as_well(self) -> None:
        engine = RankedEngine(RankedConfig(system=RatingSystem.ELO, placement_matches=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 5)
        assert state.rating.rating > 1500
        # Elo has no opinion about the deviation, so it must be left alone.
        assert state.rating.deviation == 350


class TestStreaks:
    def test_wins_build_and_a_loss_breaks(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        state = create_ranked_state()
        streaks = []
        for outcome in [
            MatchOutcome.WIN,
            MatchOutcome.WIN,
            MatchOutcome.WIN,
            MatchOutcome.LOSS,
            MatchOutcome.LOSS,
        ]:
            result = engine.record_match(state, make_rating(1500), outcome, 0)
            state = result.state
            streaks.append(result.streak)
        assert streaks == [1, 2, 3, -1, -2]

    def test_a_draw_breaks_a_streak_rather_than_continuing_it(self) -> None:
        # A run of wins interrupted by a draw is not a run of wins, and
        # treating it as one makes the bonus feel arbitrary.
        engine = RankedEngine(RankedConfig(placement_matches=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 3)
        assert state.streak == 3
        state = play(engine, state, [MatchOutcome.DRAW])
        assert state.streak == 0

    def test_the_bonus_needs_a_ladder_position_and_a_threshold(self) -> None:
        with_bonus = RankedEngine(
            RankedConfig(placement_matches=0, streak_threshold=3, streak_bonus_points=5)
        )
        without = RankedEngine(RankedConfig(placement_matches=0, streak_threshold=0))
        hot = play(with_bonus, create_ranked_state(), [MatchOutcome.WIN] * 6)
        cold = play(without, create_ranked_state(), [MatchOutcome.WIN] * 6)
        assert hot.position is not None and cold.position is not None
        # The bonus is a deliberate distortion of the maths in exchange for the
        # ladder feeling responsive; with it the player is further along.
        assert (
            hot.position.tier.order,
            hot.position.division or 0,
            hot.position.league_points,
        ) >= (
            cold.position.tier.order,
            cold.position.division or 0,
            cold.position.league_points,
        )

    def test_the_bonus_is_capped(self) -> None:
        engine = RankedEngine(
            RankedConfig(
                placement_matches=0,
                streak_threshold=2,
                streak_bonus_points=100,
                max_streak_bonus=7,
            )
        )
        # A twenty-win streak must not be worth two thousand League Points.
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 20)
        assert state.position is not None


class TestLadderMovement:
    def test_a_draw_moves_the_rating_and_leaves_the_ladder_alone(self) -> None:
        # Splitting a League Point in half would be worse than not moving.
        engine = RankedEngine(RankedConfig(placement_matches=0, streak_threshold=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN])
        before = state.position
        result = engine.record_match(state, make_rating(1500), MatchOutcome.DRAW, MINUTE)
        assert result.ladder is not None
        assert result.ladder.outcome is LadderOutcome.UNCHANGED
        assert result.ladder.points_delta == 0
        assert result.state.position == before

    def test_a_promotion_resets_the_demotion_protection_counter(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0, streak_threshold=0))
        state = create_ranked_state(make_rating(1200, 60, played=100))
        promoted = False
        for index in range(200):
            result = engine.record_match(
                state, make_rating(900, 60), MatchOutcome.WIN, index * MINUTE
            )
            state = result.state
            if result.ladder is not None and result.ladder.outcome in (
                LadderOutcome.PROMOTED_DIVISION,
                LadderOutcome.PROMOTED_TIER,
            ):
                assert state.matches_since_promotion == 0
                promoted = True
                break
        assert promoted, "a hundred wins against a weaker opponent should promote somebody"

    def test_a_season_of_matches_stays_inside_every_invariant(self) -> None:
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=10))
        state = create_ranked_state()
        seed = 12_345
        for index in range(400):
            seed = (seed * 48_271) % 2_147_483_647
            opponent = 900 + seed % 1_800
            seed = (seed * 48_271) % 2_147_483_647
            roll = seed % 100
            outcome = (
                MatchOutcome.WIN
                if roll < 47
                else MatchOutcome.LOSS
                if roll < 94
                else MatchOutcome.DRAW
            )
            result = engine.record_match(state, make_rating(opponent), outcome, index * MINUTE)
            state = result.state

            assert state.wins + state.losses + state.draws == state.season_matches == index + 1
            assert 0 <= state.rating.rating <= 5000
            assert 30 <= state.rating.deviation <= 350
            assert state.peak_rating >= state.rating.rating
            if state.position is not None:
                assert state.position.league_points >= 0
                assert state.position.tier.is_apex == (state.position.division is None)
                assert state.peak_position is not None


class TestSeasons:
    def test_a_state_from_an_old_season_is_reset_on_the_next_match(self) -> None:
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 20)
        assert state.season_id == "S1"

        next_season = Season(id="S2", name="Two", starts_at=10_000_000)
        engine = RankedEngine(RankedConfig(season=next_season, placement_matches=0))
        result = engine.record_match(state, make_rating(1500), MatchOutcome.WIN, 10_000_001)
        assert result.season_reset is True
        assert result.state.season_id == "S2"
        assert result.state.wins == 1  # the counters restarted

    def test_the_first_ever_match_is_not_a_reset(self) -> None:
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=0))
        result = engine.record_match(
            create_ranked_state(), make_rating(1500), MatchOutcome.WIN, 0
        )
        assert result.season_reset is False
        assert result.state.season_id == "S1"

    def test_a_ladder_without_seasons_never_resets(self) -> None:
        engine = RankedEngine(RankedConfig(season=None, placement_matches=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 5)
        assert state.season_id is None
        result = engine.record_match(state, make_rating(1500), MatchOutcome.WIN, 10**12)
        assert result.season_reset is False
        assert result.state.wins == 6

    def test_starting_a_season_explicitly_clears_the_record(self) -> None:
        """For the ladder that has a leaderboard.

        The leaderboard is wrong until everybody has been reset, so a caller
        with one runs the reset for the whole population at a fixed moment
        rather than lazily on each player's first match.
        """
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 20)
        fresh = engine.start_season(state, Season(id="S2", name="Two", starts_at=10_000_000))
        assert fresh.season_id == "S2"
        assert fresh.season_matches == fresh.wins == fresh.losses == fresh.draws == 0
        assert fresh.streak == 0
        assert fresh.position is None
        assert fresh.peak_position is None
        assert fresh.peak_rating == fresh.rating.rating
        # The rating carried over, softened.
        assert fresh.rating.rating != 1500 or state.rating.rating == 1500

    def test_a_none_policy_carries_the_rating_untouched(self) -> None:
        engine = RankedEngine(
            RankedConfig(
                season=SEASON,
                placement_matches=0,
                reset=SeasonResetConfig(policy=ResetPolicy.NONE),
            )
        )
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 20)
        fresh = engine.start_season(state, Season(id="S2", name="Two", starts_at=10_000_000))
        assert fresh.rating == state.rating


class TestRecordPeriod:
    def test_an_empty_period_widens_the_deviation(self) -> None:
        # The case Glicko-2 has an answer for that Elo does not.
        engine = RankedEngine(RankedConfig(placement_matches=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 20)
        before = state.rating.deviation
        result = engine.record_period(state, [], 10 * MINUTE)
        assert result.state.rating.deviation > before
        assert result.state.rating.rating == state.rating.rating
        assert result.state.season_matches == state.season_matches

    def test_a_period_of_matches_applies_them_in_order(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        result = engine.record_period(
            create_ranked_state(),
            [
                (make_rating(1400, 30), MatchOutcome.WIN),
                (make_rating(1550, 100), MatchOutcome.LOSS),
                (make_rating(1700, 300), MatchOutcome.LOSS),
            ],
            0,
        )
        assert result.state.season_matches == 3
        assert result.state.wins == 1
        assert result.state.losses == 2

    def test_the_result_describes_the_last_match(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0))
        result = engine.record_period(
            create_ranked_state(),
            [(make_rating(1500), MatchOutcome.WIN), (make_rating(1500), MatchOutcome.LOSS)],
            0,
        )
        assert result.outcome is MatchOutcome.LOSS


class TestSummary:
    def test_describes_the_season(self) -> None:
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=0))
        state = play(
            engine,
            create_ranked_state(),
            [MatchOutcome.WIN] * 6 + [MatchOutcome.LOSS] * 3 + [MatchOutcome.DRAW],
        )
        summary = engine.summarise(state)
        assert summary.season_id == "S1"
        assert summary.matches_played == 10
        assert (summary.wins, summary.losses, summary.draws) == (6, 3, 1)
        assert summary.win_rate_permille == 666
        assert summary.final_rating == state.rating.rating

    def test_the_peak_is_kept_even_after_a_slide(self) -> None:
        engine = RankedEngine(RankedConfig(placement_matches=0, streak_threshold=0))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 30, make_rating(1900))
        peak = state.peak_rating
        state = play(
            engine, state, [MatchOutcome.LOSS] * 30, make_rating(1000), start=100 * MINUTE
        )
        summary = engine.summarise(state)
        assert summary.peak_rating == peak
        assert summary.final_rating < summary.peak_rating


class TestSerialisation:
    def test_round_trips_a_new_player(self) -> None:
        state = create_ranked_state()
        assert deserialize_ranked_state(serialize_ranked_state(state)) == state

    def test_round_trips_a_played_out_season(self) -> None:
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=10))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 40)
        assert deserialize_ranked_state(serialize_ranked_state(state)) == state

    def test_round_trips_a_position_carrying_a_series(self) -> None:
        state = create_ranked_state()
        state.position = LadderPosition(
            tier=Tier.GOLD,
            division=Division.ONE,
            league_points=100,
            series=SeriesState(wins_needed=3, losses_allowed=2, wins=2, losses=1),
        )
        recovered = deserialize_ranked_state(serialize_ranked_state(state))
        assert recovered.position is not None
        assert recovered.position.series is not None
        assert recovered.position.series.wins == 2
        assert recovered.position.series.losses == 1

    def test_the_json_uses_camel_case(self) -> None:
        # Matching every other serialised shape in this library, so a bot
        # ported between the editions keeps its data.
        raw = serialize_ranked_state(create_ranked_state())
        assert "seasonMatches" in raw
        assert "matchesSincePromotion" in raw
        assert "season_matches" not in raw

    def test_survives_json_dumps_and_loads(self) -> None:
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=10))
        state = play(engine, create_ranked_state(), [MatchOutcome.WIN] * 15)
        text = json.dumps(serialize_ranked_state(state))
        assert deserialize_ranked_state(json.loads(text)) == state

    def test_a_row_from_an_older_version_still_loads(self) -> None:
        # Missing fields take their empty defaults.
        state = deserialize_ranked_state({"rating": {"rating": 1800}})
        assert state.rating.rating == 1800
        assert state.rating.deviation == 350
        assert state.position is None
        assert state.matches_since_promotion == 999
        assert state.peak_rating == 1800

    def test_an_empty_object_is_a_new_player(self) -> None:
        assert deserialize_ranked_state({}) == create_ranked_state()

    @pytest.mark.parametrize("raw", ["not a dict", 42, None, []])
    def test_refuses_something_that_is_not_a_state(self, raw: object) -> None:
        with pytest.raises(ValidationError):
            deserialize_ranked_state(raw)  # type: ignore[arg-type]

    def test_refuses_a_non_integer_field(self) -> None:
        with pytest.raises(ValidationError):
            deserialize_ranked_state({"wins": "seven"})

    def test_refuses_a_position_that_is_not_an_object(self) -> None:
        with pytest.raises(ValidationError):
            deserialize_ranked_state({"position": "GOLD"})


class TestDeterminism:
    def test_two_engines_with_the_same_config_agree_exactly(self) -> None:
        config = RankedConfig(season=SEASON, placement_matches=10)
        outcomes = [MatchOutcome.WIN, MatchOutcome.LOSS, MatchOutcome.DRAW] * 40
        first = play(RankedEngine(config), create_ranked_state(), outcomes)
        second = play(RankedEngine(config), create_ranked_state(), outcomes)
        assert serialize_ranked_state(first) == serialize_ranked_state(second)

    def test_replaying_from_a_serialised_state_continues_identically(self) -> None:
        # The property a caller relies on when they store the state in a
        # database between matches, which is the only way anybody uses this.
        engine = RankedEngine(RankedConfig(season=SEASON, placement_matches=10))
        outcomes = [MatchOutcome.WIN, MatchOutcome.WIN, MatchOutcome.LOSS] * 20

        straight_through = play(engine, create_ranked_state(), outcomes)

        round_tripped = create_ranked_state()
        for index, outcome in enumerate(outcomes):
            round_tripped = deserialize_ranked_state(serialize_ranked_state(round_tripped))
            round_tripped = engine.record_match(
                round_tripped, make_rating(1500), outcome, index * MINUTE
            ).state

        assert serialize_ranked_state(round_tripped) == serialize_ranked_state(
            straight_through
        )
