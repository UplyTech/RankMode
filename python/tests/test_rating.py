"""Elo and Glicko-2.

The reference for the Glicko-2 numbers is Glickman's own paper, "Example of the
Glicko-2 system", which works one rating period through by hand and prints the
answers. An implementation that does not reproduce it is wrong, however
plausible its numbers look, so that example is a test rather than a comment.
"""

from __future__ import annotations

from typing import Any

import pytest

from rankmode import (
    DEFAULT_DEVIATION,
    DEFAULT_RATING,
    DEFAULT_VOLATILITY,
    ConfigurationError,
    EloConfig,
    Glicko2Config,
    MatchOutcome,
    Rating,
    RatingSystem,
    ValidationError,
    create_rating,
    expected_score_permille,
    rating_interval,
    update_elo,
    update_glicko2,
)


def make_rating(
    rating: int, deviation: int, volatility: int = DEFAULT_VOLATILITY, played: int = 0
) -> Rating:
    return Rating(
        rating=rating, deviation=deviation, volatility=volatility, matches_played=played
    )


class TestMatchOutcome:
    def test_scores(self) -> None:
        assert MatchOutcome.WIN.score_permille == 1000
        assert MatchOutcome.LOSS.score_permille == 0
        assert MatchOutcome.DRAW.score_permille == 500

    def test_is_a_string_enum_so_it_survives_serialisation(self) -> None:
        assert MatchOutcome("WIN") is MatchOutcome.WIN
        assert MatchOutcome.WIN.value == "WIN"


class TestRating:
    def test_defaults_describe_a_newcomer(self) -> None:
        rating = create_rating()
        assert rating.rating == DEFAULT_RATING == 1500
        assert rating.deviation == DEFAULT_DEVIATION == 350
        assert rating.volatility == DEFAULT_VOLATILITY == 60_000
        assert rating.matches_played == 0

    def test_is_frozen(self) -> None:
        with pytest.raises(Exception):  # noqa: B017 - dataclasses raise FrozenInstanceError
            create_rating().rating = 1600  # type: ignore[misc]

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"rating": 1.5},
            {"deviation": "350"},
            {"volatility": None},
            {"matches_played": True},
        ],
    )
    def test_refuses_non_integers(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ValidationError):
            create_rating(**kwargs)

    def test_refuses_impossible_values(self) -> None:
        with pytest.raises(ValidationError):
            create_rating(deviation=-1)
        with pytest.raises(ValidationError):
            create_rating(volatility=0)
        with pytest.raises(ValidationError):
            create_rating(matches_played=-1)


class TestExpectedScore:
    def test_equal_players_are_a_coin_toss(self) -> None:
        for system in RatingSystem:
            assert (
                expected_score_permille(make_rating(1500, 50), make_rating(1500, 50), system)
                == 500
            )

    def test_four_hundred_points_is_ten_to_one_under_elo(self) -> None:
        # The definition of the Elo scale: 400 points is a factor of ten in
        # odds, which is 1/11 of the probability.
        got = expected_score_permille(
            make_rating(1500, 50), make_rating(1900, 50), RatingSystem.ELO
        )
        assert got == pytest.approx(1000 // 11, abs=1)

    def test_is_symmetric(self) -> None:
        for system in RatingSystem:
            for gap in (0, 50, 200, 400, 800):
                forward = expected_score_permille(
                    make_rating(1500, 60), make_rating(1500 + gap, 60), system
                )
                backward = expected_score_permille(
                    make_rating(1500 + gap, 60), make_rating(1500, 60), system
                )
                assert forward + backward == 1000, (system, gap)

    def test_rises_with_the_players_rating(self) -> None:
        for system in RatingSystem:
            previous = -1
            for rating in range(0, 4001, 50):
                current = expected_score_permille(
                    make_rating(rating, 60), make_rating(2000, 60), system
                )
                assert current >= previous, (system, rating)
                previous = current

    def test_an_uncertain_opponent_pulls_glicko2_towards_a_coin_toss(self) -> None:
        # The difference between the two systems, stated as a test: Elo sees
        # only the ratings, Glicko-2 also sees how much they can be trusted.
        certain = expected_score_permille(
            make_rating(1500, 30), make_rating(1900, 30), RatingSystem.GLICKO2
        )
        uncertain = expected_score_permille(
            make_rating(1500, 30), make_rating(1900, 350), RatingSystem.GLICKO2
        )
        assert uncertain > certain
        assert expected_score_permille(
            make_rating(1500, 30), make_rating(1900, 30), RatingSystem.ELO
        ) == expected_score_permille(
            make_rating(1500, 30), make_rating(1900, 350), RatingSystem.ELO
        )

    def test_stays_inside_zero_and_one_thousand_at_the_extremes(self) -> None:
        for system in RatingSystem:
            assert (
                expected_score_permille(make_rating(0, 30), make_rating(5000, 30), system) == 0
            )
            assert (
                expected_score_permille(make_rating(5000, 30), make_rating(0, 30), system)
                == 1000
            )


class TestEloConfig:
    def test_k_falls_as_a_player_settles(self) -> None:
        config = EloConfig()
        assert config.k_for(make_rating(1500, 350, played=0)) == 40
        assert config.k_for(make_rating(1500, 350, played=9)) == 40
        assert config.k_for(make_rating(1500, 60, played=10)) == 20
        assert config.k_for(make_rating(2400, 60, played=100)) == 10

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"placement_k": 0},
            {"standard_k": -1},
            {"elite_k": 0},
            {"placement_matches": -1},
            {"floor": 5000, "ceiling": 5000},
            {"floor": 100, "ceiling": 50},
        ],
    )
    def test_refuses_impossible_configuration(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ConfigurationError):
            EloConfig(**kwargs)


class TestElo:
    def test_a_win_against_an_equal_gains_half_of_k(self) -> None:
        after = update_elo(
            make_rating(1500, 60, played=50), make_rating(1500, 60), MatchOutcome.WIN
        )
        assert after.rating == 1510  # standard K of 20, expected 0.5
        assert after.matches_played == 51

    def test_a_loss_against_an_equal_costs_half_of_k(self) -> None:
        after = update_elo(
            make_rating(1500, 60, played=50), make_rating(1500, 60), MatchOutcome.LOSS
        )
        assert after.rating == 1490

    def test_a_draw_between_equals_changes_nothing(self) -> None:
        after = update_elo(
            make_rating(1500, 60, played=50), make_rating(1500, 60), MatchOutcome.DRAW
        )
        assert after.rating == 1500
        assert after.matches_played == 51

    def test_beating_a_stronger_player_is_worth_more(self) -> None:
        weak = update_elo(
            make_rating(1500, 60, played=50), make_rating(1900, 60), MatchOutcome.WIN
        )
        even = update_elo(
            make_rating(1500, 60, played=50), make_rating(1500, 60), MatchOutcome.WIN
        )
        assert weak.rating > even.rating

    def test_losing_to_a_weaker_player_costs_more(self) -> None:
        upset = update_elo(
            make_rating(1500, 60, played=50), make_rating(1100, 60), MatchOutcome.LOSS
        )
        even = update_elo(
            make_rating(1500, 60, played=50), make_rating(1500, 60), MatchOutcome.LOSS
        )
        assert upset.rating < even.rating

    def test_a_newcomer_moves_faster_than_a_veteran(self) -> None:
        newcomer = update_elo(
            make_rating(1500, 350, played=0), make_rating(1500, 60), MatchOutcome.WIN
        )
        veteran = update_elo(
            make_rating(1500, 60, played=200), make_rating(1500, 60), MatchOutcome.WIN
        )
        assert newcomer.rating - 1500 > veteran.rating - 1500

    def test_gains_and_losses_are_symmetric(self) -> None:
        for opponent in range(0, 3601, 200):
            gain = (
                update_elo(
                    make_rating(1500, 60, played=50),
                    make_rating(opponent, 60),
                    MatchOutcome.WIN,
                ).rating
                - 1500
            )
            loss = (
                1500
                - update_elo(
                    make_rating(1500, 60, played=50),
                    make_rating(opponent, 60),
                    MatchOutcome.LOSS,
                ).rating
            )
            # A win against X and a loss to X must move by amounts that add up
            # to K, or the ladder leaks or mints rating over time.
            assert gain + loss == 20, opponent

    def test_respects_the_floor_and_the_ceiling(self) -> None:
        config = EloConfig(floor=1000, ceiling=2000)
        assert (
            update_elo(
                make_rating(1000, 60, played=50),
                make_rating(3000, 60),
                MatchOutcome.LOSS,
                config,
            ).rating
            == 1000
        )
        assert (
            update_elo(
                make_rating(2000, 60, played=50), make_rating(0, 60), MatchOutcome.WIN, config
            ).rating
            == 2000
        )

    def test_leaves_deviation_and_volatility_alone(self) -> None:
        # Elo has no opinion about either; pretending otherwise would make a
        # state that switched systems mid-season nonsense.
        after = update_elo(
            make_rating(1500, 123, 77_000, 50), make_rating(1500, 60), MatchOutcome.WIN
        )
        assert after.deviation == 123
        assert after.volatility == 77_000


class TestGlicko2Config:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"tau": 0},
            {"min_deviation": 0},
            {"min_deviation": 400, "max_deviation": 350},
            {"floor": 100, "ceiling": 100},
            {"min_volatility": 0},
            {"min_volatility": 600_000, "max_volatility": 500_000},
        ],
    )
    def test_refuses_impossible_configuration(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ConfigurationError):
            Glicko2Config(**kwargs)


class TestGlicko2:
    def test_reproduces_glickmans_worked_example(self) -> None:
        """The paper's own example, to the digit it prints.

        Glickman starts a player at 1500/200/0.06, plays them against 1400,
        1550 and 1700 with results 1, 0, 0, and gets 1464.06, 151.52 and
        0.05999. Rounded to the whole points this library reports, that is
        1464 and 152.
        """
        after = update_glicko2(
            make_rating(1500, 200, 60_000, 0),
            [
                (make_rating(1400, 30), MatchOutcome.WIN),
                (make_rating(1550, 100), MatchOutcome.LOSS),
                (make_rating(1700, 300), MatchOutcome.LOSS),
            ],
        )
        assert after.rating == 1464
        assert after.deviation == 152
        assert after.volatility == 59_996
        assert after.matches_played == 3

    def test_an_idle_period_widens_the_deviation_and_moves_nothing_else(self) -> None:
        before = make_rating(1500, 60, 60_000, 40)
        after = update_glicko2(before, [])
        assert after.rating == before.rating
        assert after.deviation > before.deviation
        assert after.volatility == before.volatility
        assert after.matches_played == before.matches_played

    def test_repeated_idle_periods_climb_all_the_way_to_the_cap(self) -> None:
        """A player gone long enough becomes one the system knows nothing about.

        This is the regression test for the fixed point the decay used to have.
        ``phi* = sqrt(phi^2 + sigma^2)`` is computed from the whole-point
        deviation, and past 109 one period's growth rounded back to the number
        it started from - so an idle player climbed for forty-nine periods and
        then stopped for ever, two years of absence leaving them apparently
        known to within a hundred points.
        """
        rating = make_rating(1500, 60, 60_000, 40)
        for _ in range(500):
            rating = update_glicko2(rating, [])
        assert rating.deviation == Glicko2Config().max_deviation == 350

    def test_every_idle_period_widens_the_deviation(self) -> None:
        # Strictly, at every starting point below the cap. The property the
        # fixed point above violated.
        for deviation in range(1, 350):
            after = update_glicko2(make_rating(1500, deviation, 60_000, 40), [])
            assert after.deviation > deviation, deviation

    def test_a_win_raises_the_rating_and_a_loss_lowers_it(self) -> None:
        won = update_glicko2(
            make_rating(1500, 100, 60_000, 20), [(make_rating(1500, 100), MatchOutcome.WIN)]
        )
        lost = update_glicko2(
            make_rating(1500, 100, 60_000, 20), [(make_rating(1500, 100), MatchOutcome.LOSS)]
        )
        assert won.rating > 1500 > lost.rating

    def test_a_draw_between_equals_leaves_the_rating_where_it_was(self) -> None:
        after = update_glicko2(
            make_rating(1500, 100, 60_000, 20), [(make_rating(1500, 100), MatchOutcome.DRAW)]
        )
        assert after.rating == 1500

    def test_playing_narrows_the_deviation(self) -> None:
        after = update_glicko2(
            make_rating(1500, 200, 60_000, 5), [(make_rating(1500, 50), MatchOutcome.WIN)]
        )
        assert after.deviation < 200

    def test_an_uncertain_player_moves_further_than_a_settled_one(self) -> None:
        # The whole reason Glicko-2 exists.
        uncertain = update_glicko2(
            make_rating(1500, 300, 60_000, 2), [(make_rating(1500, 50), MatchOutcome.WIN)]
        )
        settled = update_glicko2(
            make_rating(1500, 40, 60_000, 200), [(make_rating(1500, 50), MatchOutcome.WIN)]
        )
        assert uncertain.rating - 1500 > settled.rating - 1500

    def test_a_period_is_not_the_same_as_the_matches_one_at_a_time(self) -> None:
        # Glicko-2 is defined over a period. Applying three results together is
        # the accurate reading; applying them one at a time is the noisier one
        # every implementation offers. They are allowed to differ - but both
        # must be deterministic, and both must move in the same direction.
        results = [
            (make_rating(1400, 30), MatchOutcome.WIN),
            (make_rating(1550, 100), MatchOutcome.WIN),
            (make_rating(1700, 300), MatchOutcome.WIN),
        ]
        together = update_glicko2(make_rating(1500, 200, 60_000, 0), results)

        one_at_a_time = make_rating(1500, 200, 60_000, 0)
        for result in results:
            one_at_a_time = update_glicko2(one_at_a_time, [result])

        assert together.rating > 1500
        assert one_at_a_time.rating > 1500
        assert together.matches_played == one_at_a_time.matches_played == 3

    def test_volatility_stays_inside_its_bounds(self) -> None:
        config = Glicko2Config()
        for player in range(0, 5001, 250):
            for opponent in range(0, 5001, 500):
                for outcome in MatchOutcome:
                    after = update_glicko2(
                        make_rating(player, 350, 60_000, 5),
                        [(make_rating(opponent, 30), outcome)],
                    )
                    assert config.min_volatility <= after.volatility <= config.max_volatility

    def test_survives_the_most_improbable_result_there_is(self) -> None:
        """A 200-rated player beating a 2200-rated one.

        ``E`` here is about one in a hundred thousand, the estimated variance
        blows up to five figures, and Glickman's upper bracket end -
        ``ln(delta^2 - phi^2 - v)`` - passes 22, outside the domain where the
        fixed-point ``exp`` is defined at all. Before the bracket was clamped
        this raised; in the TypeScript edition it would have silently returned
        a wrong number, because ``delta^2`` reaches 10^18 and doubles stop
        being exact at 9 x 10^15.
        """
        after = update_glicko2(
            make_rating(200, 30, 30_000, 25), [(make_rating(2200, 30), MatchOutcome.WIN)]
        )
        assert after.rating > 200
        config = Glicko2Config()
        assert config.min_volatility <= after.volatility <= config.max_volatility

    def test_a_shock_result_moves_a_known_player_less_than_an_unknown_one(self) -> None:
        # The same improbable result, against four levels of certainty. A
        # player the system is sure about barely moves however surprising the
        # result was, which is exactly what the deviation is for.
        gains = [
            update_glicko2(
                make_rating(200, dev, 60_000, 25), [(make_rating(2200, dev), MatchOutcome.WIN)]
            ).rating
            - 200
            for dev in (30, 100, 200, 350)
        ]
        assert gains == sorted(gains)
        assert gains[0] < gains[-1]

    def test_never_raises_anywhere_in_the_rating_range(self) -> None:
        for player in range(0, 5001, 200):
            for opponent in range(0, 5001, 400):
                for deviation in (1, 30, 350):
                    for volatility in (1_000, 60_000, 500_000):
                        for outcome in MatchOutcome:
                            update_glicko2(
                                make_rating(player, deviation, volatility, 25),
                                [(make_rating(opponent, deviation), outcome)],
                            )

    def test_respects_the_rating_bounds(self) -> None:
        config = Glicko2Config(floor=1400, ceiling=1600)
        after = update_glicko2(
            make_rating(1600, 350, 60_000, 0),
            [(make_rating(5000, 30), MatchOutcome.WIN)],
            config,
        )
        assert after.rating <= 1600
        after = update_glicko2(
            make_rating(1400, 350, 60_000, 0),
            [(make_rating(0, 30), MatchOutcome.LOSS)],
            config,
        )
        assert after.rating >= 1400

    def test_deviation_is_held_between_its_bounds(self) -> None:
        config = Glicko2Config(min_deviation=50, max_deviation=100)
        after = update_glicko2(
            make_rating(1500, 100, 60_000, 500),
            [(make_rating(1500, 30), MatchOutcome.WIN)],
            config,
        )
        assert 50 <= after.deviation <= 100

    def test_an_opponent_the_system_knows_nothing_about_carries_no_information(self) -> None:
        # g(phi) falls towards zero as the opponent's deviation grows, so a
        # match against somebody unrated moves the rating hardly at all.
        known = update_glicko2(
            make_rating(1500, 100, 60_000, 20), [(make_rating(1500, 30), MatchOutcome.WIN)]
        )
        unknown = update_glicko2(
            make_rating(1500, 100, 60_000, 20), [(make_rating(1500, 350), MatchOutcome.WIN)]
        )
        assert known.rating > unknown.rating


class TestRatingInterval:
    def test_a_certain_player_has_a_narrow_interval(self) -> None:
        low, high = rating_interval(make_rating(1500, 30))
        assert high - low < 150
        assert low < 1500 < high

    def test_a_newcomer_has_a_very_wide_one(self) -> None:
        low, high = rating_interval(make_rating(1500, 350))
        # Glickman's own reading of 350: roughly 800 to 2200, which is
        # "we have no idea" said in numbers.
        assert low <= 815
        assert high >= 2185

    def test_is_centred_on_the_rating(self) -> None:
        for deviation in (0, 30, 175, 350):
            low, high = rating_interval(make_rating(1500, deviation))
            assert (low + high) == 3000

    def test_wider_confidence_gives_a_wider_interval(self) -> None:
        widths = [
            rating_interval(make_rating(1500, 100), confidence)[1]
            - rating_interval(make_rating(1500, 100), confidence)[0]
            for confidence in (680, 900, 950, 990)
        ]
        assert widths == sorted(widths)
        assert len(set(widths)) == 4

    def test_refuses_a_confidence_it_has_no_quantile_for(self) -> None:
        with pytest.raises(ValidationError):
            rating_interval(make_rating(1500, 100), 975)


class TestDeterminism:
    def test_the_same_inputs_always_give_the_same_answer(self) -> None:
        for _ in range(3):
            assert update_glicko2(
                make_rating(1500, 200, 60_000, 0),
                [
                    (make_rating(1400, 30), MatchOutcome.WIN),
                    (make_rating(1700, 300), MatchOutcome.LOSS),
                ],
            ) == update_glicko2(
                make_rating(1500, 200, 60_000, 0),
                [
                    (make_rating(1400, 30), MatchOutcome.WIN),
                    (make_rating(1700, 300), MatchOutcome.LOSS),
                ],
            )

    def test_the_engine_never_mutates_what_it_is_given(self) -> None:
        before = make_rating(1500, 200, 60_000, 7)
        update_elo(before, make_rating(1600, 60), MatchOutcome.WIN)
        update_glicko2(before, [(make_rating(1600, 60), MatchOutcome.WIN)])
        assert before == make_rating(1500, 200, 60_000, 7)
