"""Seasons, resets and summaries."""

from __future__ import annotations

from typing import Any

import pytest

from rankmode import (
    ConfigurationError,
    Division,
    LadderPosition,
    Rating,
    ResetPolicy,
    Season,
    SeasonError,
    SeasonResetConfig,
    SeasonSummary,
    Tier,
    ValidationError,
    is_within,
    reset_position,
    reset_rating,
    season_for,
)

DAY = 86_400_000


def make_rating(
    rating: int, deviation: int = 60, volatility: int = 60_000, played: int = 40
) -> Rating:
    return Rating(
        rating=rating, deviation=deviation, volatility=volatility, matches_played=played
    )


class TestSeason:
    def test_contains_its_own_range(self) -> None:
        season = Season(id="S1", name="One", starts_at=0, ends_at=100 * DAY)
        assert season.contains(0) is True
        assert season.contains(50 * DAY) is True
        assert season.contains(100 * DAY - 1) is True

    def test_the_end_is_exclusive_so_two_seasons_can_meet(self) -> None:
        first = Season(id="S1", name="One", starts_at=0, ends_at=100 * DAY)
        second = Season(id="S2", name="Two", starts_at=100 * DAY, ends_at=200 * DAY)
        assert first.contains(100 * DAY) is False
        assert second.contains(100 * DAY) is True

    def test_an_open_ended_season_runs_for_ever(self) -> None:
        season = Season(id="S1", name="One", starts_at=0)
        assert season.contains(10**15) is True
        assert season.contains(-1) is False

    def test_is_within_is_the_same_question(self) -> None:
        season = Season(id="S1", name="One", starts_at=0, ends_at=DAY)
        for timestamp in (-1, 0, DAY // 2, DAY, DAY * 2):
            assert is_within(season, timestamp) == season.contains(timestamp)

    def test_refuses_an_empty_id(self) -> None:
        with pytest.raises(ConfigurationError):
            Season(id="", name="One", starts_at=0)

    def test_refuses_non_integer_timestamps(self) -> None:
        with pytest.raises(ConfigurationError):
            Season(id="S1", name="One", starts_at=1.5)  # type: ignore[arg-type]
        with pytest.raises(ConfigurationError):
            Season(id="S1", name="One", starts_at=0, ends_at="later")  # type: ignore[arg-type]

    def test_refuses_a_season_that_ends_before_it_begins(self) -> None:
        with pytest.raises(SeasonError):
            Season(id="S1", name="One", starts_at=100, ends_at=100)
        with pytest.raises(SeasonError):
            Season(id="S1", name="One", starts_at=100, ends_at=50)


class TestSeasonFor:
    SEASONS = [
        Season(id="S1", name="One", starts_at=0, ends_at=100 * DAY),
        # A deliberate gap: the week where last season is over and the next has
        # not begun. Normal, and not an error.
        Season(id="S2", name="Two", starts_at=107 * DAY, ends_at=200 * DAY),
        Season(id="S3", name="Three", starts_at=200 * DAY),
    ]

    def test_finds_the_season_a_timestamp_falls_in(self) -> None:
        for timestamp, expected in ((50 * DAY, "S1"), (150 * DAY, "S2"), (10**15, "S3")):
            found = season_for(self.SEASONS, timestamp)
            assert found is not None
            assert found.id == expected

    def test_a_gap_between_seasons_is_none_not_an_error(self) -> None:
        assert season_for(self.SEASONS, 103 * DAY) is None

    def test_before_the_first_season_is_none(self) -> None:
        assert season_for(self.SEASONS, -1) is None

    def test_an_empty_list_is_none(self) -> None:
        assert season_for([], 0) is None

    def test_refuses_a_non_integer_timestamp(self) -> None:
        with pytest.raises(ValidationError):
            season_for(self.SEASONS, 1.5)  # type: ignore[arg-type]


class TestResetConfig:
    @pytest.mark.parametrize(
        "kwargs", [{"pull_permille": -1}, {"pull_permille": 1001}, {"reset_deviation": 0}]
    )
    def test_refuses_impossible_configuration(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ConfigurationError):
            SeasonResetConfig(**kwargs)

    def test_the_defaults_describe_a_soft_reset(self) -> None:
        config = SeasonResetConfig()
        assert config.policy is ResetPolicy.SOFT
        assert config.pull_permille == 500
        assert config.reset_deviation == 175
        assert config.keep_volatility is True


class TestReset:
    def test_none_changes_nothing_at_all(self) -> None:
        before = make_rating(2400, deviation=45, volatility=71_000, played=93)
        assert reset_rating(before, SeasonResetConfig(policy=ResetPolicy.NONE)) == before

    def test_hard_returns_everybody_to_the_start(self) -> None:
        after = reset_rating(make_rating(2400), SeasonResetConfig(policy=ResetPolicy.HARD))
        assert after.rating == 1500
        assert after.deviation == 350
        assert after.matches_played == 0

    def test_soft_pulls_halfway_to_the_mean(self) -> None:
        assert reset_rating(make_rating(2500), SeasonResetConfig()).rating == 2000
        assert reset_rating(make_rating(500), SeasonResetConfig()).rating == 1000
        assert reset_rating(make_rating(1500), SeasonResetConfig()).rating == 1500

    def test_a_pull_of_zero_keeps_the_rating(self) -> None:
        assert (
            reset_rating(make_rating(2400), SeasonResetConfig(pull_permille=0)).rating == 2400
        )

    def test_a_pull_of_one_thousand_is_a_hard_reset_by_another_name(self) -> None:
        assert (
            reset_rating(make_rating(2400), SeasonResetConfig(pull_permille=1000)).rating
            == 1500
        )

    def test_is_symmetric_about_the_mean(self) -> None:
        # A player above the mean and one equally far below must move by the
        # same amount, or the reset drifts the population.
        for distance in range(0, 2001, 37):
            up = reset_rating(make_rating(1500 + distance), SeasonResetConfig()).rating - 1500
            down = (
                1500 - reset_rating(make_rating(1500 - distance), SeasonResetConfig()).rating
            )
            assert up == down, distance

    def test_widens_the_deviation_so_the_first_matches_count_for_more(self) -> None:
        after = reset_rating(make_rating(2000, deviation=40), SeasonResetConfig())
        assert after.deviation == 175
        assert after.deviation > 40

    def test_keeps_the_volatility_by_default(self) -> None:
        # A player whose results were erratic last season is likely to be
        # erratic this season, and that is information worth keeping.
        assert (
            reset_rating(make_rating(2000, volatility=98_000), SeasonResetConfig()).volatility
            == 98_000
        )

    def test_can_be_asked_to_drop_the_volatility(self) -> None:
        after = reset_rating(
            make_rating(2000, volatility=98_000), SeasonResetConfig(keep_volatility=False)
        )
        assert after.volatility == Rating().volatility

    def test_resets_the_match_count_so_placements_happen_again(self) -> None:
        assert (
            reset_rating(make_rating(2000, played=250), SeasonResetConfig()).matches_played
            == 0
        )

    def test_can_be_asked_to_keep_the_match_count(self) -> None:
        after = reset_rating(
            make_rating(2000, played=250), SeasonResetConfig(reset_matches_played=False)
        )
        assert after.matches_played == 250

    def test_preserves_the_ordering_of_the_population(self) -> None:
        # A soft reset compresses the ladder; it must not reorder it.
        ratings = list(range(0, 4001, 50))
        reset = [
            reset_rating(make_rating(rating), SeasonResetConfig()).rating for rating in ratings
        ]
        assert reset == sorted(reset)

    def test_a_custom_mean_moves_the_target(self) -> None:
        after = reset_rating(make_rating(2500), SeasonResetConfig(mean_rating=2000))
        assert after.rating == 2250


class TestResetPosition:
    def test_derives_the_bracket_from_the_reset_rating(self) -> None:
        # Not carried over from last season: the bracket is a display of the
        # rating, and the rating just moved.
        position = reset_position(make_rating(2900))
        assert position.tier is not Tier.CHALLENGER
        assert position.tier is Tier.DIAMOND  # 2900 pulled halfway to 1500 is 2200

    def test_a_none_policy_leaves_the_player_where_they_were(self) -> None:
        position = reset_position(
            make_rating(2900), SeasonResetConfig(policy=ResetPolicy.NONE)
        )
        assert position.tier is Tier.CHALLENGER


class TestSummary:
    def test_win_rate_excludes_draws_from_the_denominator(self) -> None:
        # A win rate is read as "how often do I win when it is decided". With
        # draws in the denominator a ladder with many of them shows everybody
        # at 500 and the number stops meaning anything.
        summary = SeasonSummary(
            season_id="S1",
            matches_played=100,
            wins=40,
            losses=20,
            draws=40,
            peak_rating=1800,
            final_rating=1700,
        )
        assert summary.win_rate_permille == 666

    def test_win_rate_of_a_player_who_never_finished_a_match(self) -> None:
        summary = SeasonSummary(
            season_id="S1",
            matches_played=3,
            wins=0,
            losses=0,
            draws=3,
            peak_rating=1500,
            final_rating=1500,
        )
        assert summary.win_rate_permille == 0

    def test_carries_the_peak_separately_from_the_final_standing(self) -> None:
        # Rewards are based on the peak: a player who reached Diamond in March
        # and slipped to Platinum in May earned the Diamond reward. Basing them
        # on the final standing teaches players to stop once they hit target.
        peak = LadderPosition(tier=Tier.DIAMOND, division=Division.ONE, league_points=50)
        final = LadderPosition(tier=Tier.PLATINUM, division=Division.TWO, league_points=20)
        summary = SeasonSummary(
            season_id="S1",
            matches_played=200,
            wins=110,
            losses=90,
            draws=0,
            peak_rating=2200,
            final_rating=1950,
            peak_position=peak,
            final_position=final,
        )
        assert summary.peak_position is peak
        assert summary.final_position is final
        assert summary.peak_rating > summary.final_rating
