"""The ladder: tiers, divisions, League Points and promotion series.

The ladder is the half of the system a player actually sees, and almost every
rule in it exists because the obvious behaviour felt wrong rather than because
it was arithmetically incorrect. The tests say which is which.
"""

from __future__ import annotations

from typing import Any

import pytest

from rankmode import (
    ConfigurationError,
    Division,
    LadderConfig,
    LadderError,
    LadderOutcome,
    LadderPosition,
    SeriesState,
    Tier,
    ValidationError,
    apply_league_points,
    compare_positions,
    default_tiers,
    format_position,
    position_for_rating,
    rating_for_position,
)

LADDER = LadderConfig()
APEX = (Tier.MASTER, Tier.GRANDMASTER, Tier.CHALLENGER)


def make_position(
    tier: Tier, division: Division | None, points: int, series: SeriesState | None = None
) -> LadderPosition:
    return LadderPosition(tier=tier, division=division, league_points=points, series=series)


class TestTiers:
    def test_there_are_nine_lowest_first(self) -> None:
        assert len(default_tiers()) == 9
        assert default_tiers()[0] is Tier.IRON
        assert default_tiers()[-1] is Tier.CHALLENGER

    def test_index_orders_them(self) -> None:
        indices = [tier.order for tier in default_tiers()]
        assert indices == list(range(9))

    def test_the_top_three_have_no_divisions(self) -> None:
        for tier in default_tiers():
            assert tier.is_apex == (tier in APEX), tier


class TestDivisions:
    def test_a_larger_value_is_a_better_position(self) -> None:
        assert Division.FOUR < Division.THREE < Division.TWO < Division.ONE

    def test_labels_are_the_numerals_a_player_reads(self) -> None:
        assert Division.FOUR.label == "IV"
        assert Division.THREE.label == "III"
        assert Division.TWO.label == "II"
        assert Division.ONE.label == "I"


class TestLadderPosition:
    def test_an_apex_tier_cannot_carry_a_division(self) -> None:
        with pytest.raises(LadderError):
            make_position(Tier.MASTER, Division.ONE, 0)

    def test_a_tier_below_apex_must_carry_one(self) -> None:
        with pytest.raises(LadderError):
            make_position(Tier.GOLD, None, 0)

    def test_points_cannot_be_negative(self) -> None:
        with pytest.raises(ValidationError):
            make_position(Tier.GOLD, Division.FOUR, -1)


class TestLadderConfig:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"tier_thresholds": (0, 100)},
            {"tier_thresholds": (0, 800, 800, 1400, 1700, 2000, 2300, 2600, 2900)},
            {"tier_thresholds": (0, 800, 700, 1400, 1700, 2000, 2300, 2600, 2900)},
            {"points_per_division": 0},
            {"base_points_gain": -1},
            {"base_points_loss": -1},
            {"adjustment_span_permille": 1001},
            {"demotion_protection_matches": -1},
        ],
    )
    def test_refuses_impossible_configuration(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ConfigurationError):
            LadderConfig(**kwargs)

    def test_series_can_be_switched_off(self) -> None:
        assert LadderConfig().uses_series is True
        assert LadderConfig(series_on_tier_promotion=False).uses_series is False
        assert LadderConfig(series_wins_needed=0).uses_series is False


class TestSeeding:
    def test_the_bottom_of_the_ladder(self) -> None:
        position = position_for_rating(0, LADDER)
        assert position.tier is Tier.IRON
        assert position.division is Division.FOUR
        assert position.league_points == 0

    def test_the_top_of_the_ladder_has_no_division(self) -> None:
        position = position_for_rating(3500, LADDER)
        assert position.tier is Tier.CHALLENGER
        assert position.division is None
        # Above apex the points are the ladder: one per rating point.
        assert position.league_points == 3500 - 2900

    def test_thresholds_land_at_the_bottom_of_their_tier(self) -> None:
        for index, threshold in enumerate(LADDER.tier_thresholds):
            position = position_for_rating(threshold, LADDER)
            assert position.tier is default_tiers()[index], threshold
            if not position.tier.is_apex:
                assert position.division is Division.FOUR
                assert position.league_points == 0

    def test_one_below_a_threshold_is_the_tier_below(self) -> None:
        for index in range(1, len(LADDER.tier_thresholds)):
            position = position_for_rating(LADDER.tier_thresholds[index] - 1, LADDER)
            assert position.tier is default_tiers()[index - 1]

    def test_is_monotone_across_the_whole_range(self) -> None:
        previous = position_for_rating(0, LADDER)
        for rating in range(1, 4001):
            current = position_for_rating(rating, LADDER)
            assert compare_positions(current, previous) >= 0, rating
            previous = current

    def test_round_trips_back_into_the_same_bracket(self) -> None:
        for rating in range(0, 4001, 3):
            position = position_for_rating(rating, LADDER)
            recovered = position_for_rating(rating_for_position(position, LADDER), LADDER)
            assert recovered.tier is position.tier, rating
            assert recovered.division is position.division, rating

    def test_a_rating_below_the_floor_seeds_to_the_bottom(self) -> None:
        """Found by the differential harness, in both editions at once.

        A negative rating made ``into_tier`` negative, floor division sent the
        division index to -1, and ``Division(0)`` does not exist: this edition
        raised and the TypeScript one cast the -1 and returned a position with
        division zero that no other function accepts. The floor is
        configurable and this function takes any integer, so a rating below the
        bottom of the ladder is an ordinary input with an obvious answer.
        """
        for rating in (-1, -100, -1_000_000):
            position = position_for_rating(rating, LADDER)
            assert position.tier is Tier.IRON, rating
            assert position.division is Division.FOUR, rating
            assert position.league_points == 0, rating

    def test_refuses_a_non_integer_rating(self) -> None:
        with pytest.raises(ValidationError):
            position_for_rating(1500.5, LADDER)  # type: ignore[arg-type]

    def test_every_division_of_every_tier_is_reachable(self) -> None:
        seen = {
            (position.tier, position.division)
            for position in (position_for_rating(rating, LADDER) for rating in range(0, 4001))
        }
        expected = {(tier, None) for tier in APEX} | {
            (tier, division)
            for tier in default_tiers()
            if not tier.is_apex
            for division in Division
        }
        assert seen == expected


class TestFormatting:
    def test_reads_the_way_a_player_would_say_it(self) -> None:
        assert format_position(make_position(Tier.GOLD, Division.TWO, 47)) == "Gold II, 47 LP"
        assert format_position(make_position(Tier.IRON, Division.FOUR, 0)) == "Iron IV, 0 LP"

    def test_an_apex_position_has_no_numeral(self) -> None:
        assert (
            format_position(make_position(Tier.CHALLENGER, None, 1234))
            == "Challenger, 1234 LP"
        )


class TestComparison:
    def test_tier_beats_division_beats_points(self) -> None:
        assert (
            compare_positions(
                make_position(Tier.GOLD, Division.FOUR, 0),
                make_position(Tier.SILVER, Division.ONE, 99),
            )
            == 1
        )
        assert (
            compare_positions(
                make_position(Tier.GOLD, Division.THREE, 0),
                make_position(Tier.GOLD, Division.FOUR, 99),
            )
            == 1
        )
        assert (
            compare_positions(
                make_position(Tier.GOLD, Division.FOUR, 50),
                make_position(Tier.GOLD, Division.FOUR, 49),
            )
            == 1
        )

    def test_equal_positions_compare_equal(self) -> None:
        assert (
            compare_positions(
                make_position(Tier.GOLD, Division.TWO, 30),
                make_position(Tier.GOLD, Division.TWO, 30),
            )
            == 0
        )

    def test_is_antisymmetric(self) -> None:
        positions = [position_for_rating(rating, LADDER) for rating in range(0, 4001, 137)]
        for left in positions:
            for right in positions:
                assert compare_positions(left, right) == -compare_positions(right, left)


class TestPoints:
    def test_a_win_gains_and_a_loss_costs(self) -> None:
        position = make_position(Tier.GOLD, Division.THREE, 50)
        rating = rating_for_position(position, LADDER)
        assert apply_league_points(position, True, rating, LADDER).points_delta > 0
        assert apply_league_points(position, False, rating, LADDER).points_delta < 0

    def test_an_under_ranked_player_climbs_faster(self) -> None:
        """The entire reason the rating and the ladder are separate numbers."""
        position = make_position(Tier.GOLD, Division.THREE, 50)
        matching = rating_for_position(position, LADDER)
        under = apply_league_points(position, True, matching + 400, LADDER).points_delta
        even = apply_league_points(position, True, matching, LADDER).points_delta
        over = apply_league_points(position, True, matching - 400, LADDER).points_delta
        assert under > even > over

    def test_an_under_ranked_player_loses_less(self) -> None:
        position = make_position(Tier.GOLD, Division.THREE, 50)
        matching = rating_for_position(position, LADDER)
        under = apply_league_points(position, False, matching + 400, LADDER).points_delta
        over = apply_league_points(position, False, matching - 400, LADDER).points_delta
        assert under > over  # both negative; the under-ranked loss is smaller

    def test_a_match_is_always_worth_at_least_one_point(self) -> None:
        # Rounding to zero would make a match feel like it did not happen.
        for rating in range(0, 4001, 50):
            for won in (True, False):
                for tier in default_tiers():
                    position = make_position(
                        tier,
                        None if tier.is_apex else Division.THREE,
                        50,
                    )
                    delta = apply_league_points(position, won, rating, LADDER).points_delta
                    assert delta != 0, (tier, rating, won)

    def test_the_adjustment_can_be_switched_off(self) -> None:
        config = LadderConfig(adjustment_span_permille=0)
        position = make_position(Tier.GOLD, Division.THREE, 50)
        for rating in (0, 1500, 4000):
            assert apply_league_points(position, True, rating, config).points_delta == 20
            assert apply_league_points(position, False, rating, config).points_delta == -18


class TestDivisionPromotion:
    def test_crossing_a_hundred_moves_up_a_division(self) -> None:
        position = make_position(Tier.GOLD, Division.FOUR, 95)
        change = apply_league_points(
            position, True, rating_for_position(position, LADDER), LADDER
        )
        assert change.outcome is LadderOutcome.PROMOTED_DIVISION
        assert change.current.division is Division.THREE
        assert change.tier_changed is False

    def test_the_surplus_points_carry_over(self) -> None:
        position = make_position(Tier.GOLD, Division.FOUR, 95)
        change = apply_league_points(
            position, True, rating_for_position(position, LADDER), LADDER
        )
        assert change.current.league_points == 95 + change.points_delta - 100

    def test_a_division_promotion_needs_no_series(self) -> None:
        # They happen too often for a ceremony.
        position = make_position(Tier.GOLD, Division.THREE, 99)
        change = apply_league_points(
            position, True, rating_for_position(position, LADDER), LADDER
        )
        assert change.current.series is None
        assert change.series_active is False


class TestTierPromotion:
    def test_leaving_a_tier_starts_a_series(self) -> None:
        position = make_position(Tier.GOLD, Division.ONE, 99)
        change = apply_league_points(
            position, True, rating_for_position(position, LADDER), LADDER
        )
        assert change.outcome is LadderOutcome.SERIES_STARTED
        assert change.current.series is not None
        assert change.current.tier is Tier.GOLD  # not yet
        assert change.series_active is True

    def test_without_series_it_promotes_directly(self) -> None:
        config = LadderConfig(series_on_tier_promotion=False)
        position = make_position(Tier.GOLD, Division.ONE, 99)
        change = apply_league_points(
            position, True, rating_for_position(position, config), config
        )
        assert change.outcome is LadderOutcome.PROMOTED_TIER
        assert change.current.tier is Tier.PLATINUM
        assert change.current.division is Division.FOUR
        assert change.tier_changed is True

    def test_promoting_into_apex_arrives_without_a_division(self) -> None:
        config = LadderConfig(series_on_tier_promotion=False)
        position = make_position(Tier.DIAMOND, Division.ONE, 99)
        change = apply_league_points(
            position, True, rating_for_position(position, config), config
        )
        assert change.current.tier is Tier.MASTER
        assert change.current.division is None

    def test_the_top_of_the_ladder_has_nowhere_to_go(self) -> None:
        position = make_position(Tier.CHALLENGER, None, 5000)
        change = apply_league_points(position, True, 4000, LADDER)
        # Apex points simply accumulate; there is no tier above.
        assert change.current.tier is Tier.CHALLENGER
        assert change.current.league_points > 5000


class TestSeries:
    def test_a_win_advances_it(self) -> None:
        position = make_position(
            Tier.GOLD, Division.ONE, 100, SeriesState(wins_needed=3, losses_allowed=2)
        )
        change = apply_league_points(position, True, 1500, LADDER)
        assert change.outcome is LadderOutcome.SERIES_ADVANCED
        assert change.current.series is not None
        assert change.current.series.wins == 1

    def test_points_do_not_move_during_one(self) -> None:
        position = make_position(
            Tier.GOLD, Division.ONE, 100, SeriesState(wins_needed=3, losses_allowed=2)
        )
        for won in (True, False):
            change = apply_league_points(position, won, 1500, LADDER)
            assert change.points_delta == 0
            assert change.current.league_points == 100

    def test_three_wins_promote(self) -> None:
        position = make_position(Tier.GOLD, Division.ONE, 100, SeriesState(3, 2, wins=2))
        change = apply_league_points(position, True, 1500, LADDER)
        assert change.outcome is LadderOutcome.PROMOTED_TIER
        assert change.current.tier is Tier.PLATINUM
        assert change.current.series is None
        assert change.tier_changed is True

    def test_three_losses_fail_it(self) -> None:
        position = make_position(Tier.GOLD, Division.ONE, 100, SeriesState(3, 2, losses=2))
        change = apply_league_points(position, False, 1500, LADDER)
        assert change.outcome is LadderOutcome.SERIES_FAILED
        assert change.current.tier is Tier.GOLD
        assert change.current.series is None
        # Dropped to three quarters, not to zero: failing should cost something
        # without erasing the climb to it.
        assert change.current.league_points == 75

    def test_played_out_to_a_win(self) -> None:
        position = make_position(Tier.GOLD, Division.ONE, 99)
        change = apply_league_points(
            position, True, rating_for_position(position, LADDER), LADDER
        )
        outcomes = [change.outcome]
        for _ in range(3):
            change = apply_league_points(change.current, True, 1500, LADDER)
            outcomes.append(change.outcome)
        assert outcomes == [
            LadderOutcome.SERIES_STARTED,
            LadderOutcome.SERIES_ADVANCED,
            LadderOutcome.SERIES_ADVANCED,
            LadderOutcome.PROMOTED_TIER,
        ]
        assert change.current.tier is Tier.PLATINUM

    @pytest.mark.parametrize(
        "kwargs", [{"wins_needed": 0}, {"wins_needed": -1}, {"losses_allowed": -1}]
    )
    def test_refuses_impossible_configuration(self, kwargs: dict[str, Any]) -> None:
        defaults = {"wins_needed": 3, "losses_allowed": 2}
        with pytest.raises(ConfigurationError):
            SeriesState(**{**defaults, **kwargs})

    def test_refuses_negative_results(self) -> None:
        with pytest.raises(ValidationError):
            SeriesState(wins_needed=3, losses_allowed=2, wins=-1)


class TestDemotion:
    def test_falling_below_zero_drops_a_division(self) -> None:
        position = make_position(Tier.GOLD, Division.THREE, 5)
        change = apply_league_points(
            position, False, rating_for_position(position, LADDER), LADDER, 999
        )
        assert change.outcome is LadderOutcome.DEMOTED_DIVISION
        assert change.current.division is Division.FOUR
        assert change.current.league_points == 100 + 5 + change.points_delta

    def test_falling_out_of_division_four_drops_a_tier(self) -> None:
        position = make_position(Tier.GOLD, Division.FOUR, 5)
        change = apply_league_points(
            position, False, rating_for_position(position, LADDER), LADDER, 999
        )
        assert change.outcome is LadderOutcome.DEMOTED_TIER
        assert change.current.tier is Tier.SILVER
        assert change.current.division is Division.ONE
        # Landing at 75 rather than 99, so one win does not immediately start
        # another series. Bouncing on a tier boundary is the worst experience a
        # ladder has.
        assert change.current.league_points == 75

    def test_a_freshly_promoted_player_is_protected(self) -> None:
        position = make_position(Tier.GOLD, Division.FOUR, 5)
        change = apply_league_points(
            position, False, rating_for_position(position, LADDER), LADDER, 0
        )
        assert change.outcome is LadderOutcome.FLOOR_HELD
        assert change.current.tier is Tier.GOLD
        assert change.current.league_points == 0

    def test_the_protection_expires(self) -> None:
        position = make_position(Tier.GOLD, Division.FOUR, 5)
        rating = rating_for_position(position, LADDER)
        held = apply_league_points(position, False, rating, LADDER, 2)
        dropped = apply_league_points(position, False, rating, LADDER, 3)
        assert held.outcome is LadderOutcome.FLOOR_HELD
        assert dropped.outcome is LadderOutcome.DEMOTED_TIER

    def test_the_bottom_of_the_ladder_holds(self) -> None:
        position = make_position(Tier.IRON, Division.FOUR, 5)
        change = apply_league_points(position, False, 0, LADDER, 999)
        assert change.outcome is LadderOutcome.FLOOR_HELD
        assert change.current.tier is Tier.IRON
        assert change.current.league_points == 0

    def test_tier_demotion_can_be_switched_off(self) -> None:
        config = LadderConfig(allow_tier_demotion=False)
        position = make_position(Tier.GOLD, Division.FOUR, 5)
        change = apply_league_points(position, False, 1400, config, 999)
        assert change.outcome is LadderOutcome.FLOOR_HELD
        assert change.current.tier is Tier.GOLD

    def test_a_tier_floor_stops_the_fall(self) -> None:
        config = LadderConfig(tier_floor=Tier.GOLD)
        position = make_position(Tier.GOLD, Division.FOUR, 5)
        change = apply_league_points(position, False, 1400, config, 999)
        assert change.outcome is LadderOutcome.FLOOR_HELD
        assert change.current.tier is Tier.GOLD

    def test_falling_out_of_apex_drops_into_the_tier_below(self) -> None:
        position = make_position(Tier.MASTER, None, 5)
        change = apply_league_points(position, False, 2300, LADDER, 999)
        assert change.outcome is LadderOutcome.DEMOTED_TIER
        assert change.current.tier is Tier.DIAMOND
        assert change.current.division is Division.ONE


class TestInvariants:
    def test_a_position_never_comes_back_with_negative_points(self) -> None:
        for tier in default_tiers():
            divisions = [None] if tier.is_apex else list(Division)
            for division in divisions:
                for points in (0, 1, 50, 99):
                    position = make_position(tier, division, points)
                    for won in (True, False):
                        for rating in range(0, 4001, 250):
                            for since in (0, 3, 999):
                                change = apply_league_points(
                                    position, won, rating, LADDER, since
                                )
                                assert change.current.league_points >= 0

    def test_an_apex_tier_never_comes_back_with_a_division(self) -> None:
        for tier in default_tiers():
            divisions = [None] if tier.is_apex else list(Division)
            for division in divisions:
                position = make_position(tier, division, 99)
                for won in (True, False):
                    change = apply_league_points(position, won, 2500, LADDER, 999)
                    assert change.current.tier.is_apex == (change.current.division is None)

    def test_the_input_position_is_never_mutated(self) -> None:
        position = make_position(Tier.GOLD, Division.ONE, 99)
        apply_league_points(position, True, 1500, LADDER)
        apply_league_points(position, False, 1500, LADDER)
        assert position.league_points == 99
        assert position.division is Division.ONE
        assert position.series is None

    def test_a_tier_moves_by_at_most_one_step_per_match(self) -> None:
        for tier in default_tiers():
            divisions = [None] if tier.is_apex else list(Division)
            for division in divisions:
                for points in (0, 99):
                    position = make_position(tier, division, points)
                    for won in (True, False):
                        change = apply_league_points(position, won, 2000, LADDER, 999)
                        assert abs(change.current.tier.order - tier.order) <= 1
