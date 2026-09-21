"""Match quality and team balancing."""

from __future__ import annotations

import pytest

from rankmode import (
    Rating,
    RatingSystem,
    ValidationError,
    balance_teams,
    is_acceptable,
    match_quality,
    team_rating,
)


def make_rating(
    rating: int, deviation: int = 60, volatility: int = 60_000, played: int = 40
) -> Rating:
    return Rating(
        rating=rating, deviation=deviation, volatility=volatility, matches_played=played
    )


class TestMatchQuality:
    def test_two_equal_certain_players_are_the_best_match_there_is(self) -> None:
        quality = match_quality(make_rating(1500, 30), make_rating(1500, 30))
        assert quality.win_probability_permille == 500
        assert quality.rating_gap == 0
        assert quality.confident is True
        assert quality.quality_permille > 700

    def test_a_foregone_conclusion_scores_nothing(self) -> None:
        assert match_quality(make_rating(500, 30), make_rating(3500, 30)).quality_permille == 0

    def test_quality_falls_faster_than_the_gap_grows(self) -> None:
        """Deliberately not linear.

        An expected score of 550 is a good match, 650 is a mediocre one and 750
        is not worth playing. A linear scale would call the last of those half
        quality, which would let a queue serve it.
        """
        qualities = [
            match_quality(
                make_rating(1500, 30), make_rating(1500 + gap, 30), RatingSystem.ELO
            ).quality_permille
            for gap in (0, 100, 200, 400, 800)
        ]
        assert qualities == sorted(qualities, reverse=True)
        drops = [qualities[i] - qualities[i + 1] for i in range(len(qualities) - 1)]
        assert drops[0] < drops[1]

    def test_is_symmetric(self) -> None:
        for gap in (0, 100, 400, 1200):
            left = match_quality(make_rating(1500), make_rating(1500 + gap))
            right = match_quality(make_rating(1500 + gap), make_rating(1500))
            assert left.quality_permille == right.quality_permille
            assert left.rating_gap == -right.rating_gap

    def test_the_gap_is_signed_towards_the_first_side(self) -> None:
        assert match_quality(make_rating(1800), make_rating(1500)).rating_gap == 300
        assert match_quality(make_rating(1500), make_rating(1800)).rating_gap == -300

    def test_uncertainty_discounts_the_quality_under_glicko2(self) -> None:
        # A match that looks even between two unknowns is a guess, not a good
        # pairing, and the number has to say so.
        certain = match_quality(
            make_rating(1500, 30), make_rating(1500, 30), RatingSystem.GLICKO2
        )
        unknown = match_quality(
            make_rating(1500, 350), make_rating(1500, 350), RatingSystem.GLICKO2
        )
        assert certain.quality_permille > unknown.quality_permille
        assert certain.confident is True
        assert unknown.confident is False

    def test_elo_has_no_opinion_about_uncertainty(self) -> None:
        certain = match_quality(make_rating(1500, 30), make_rating(1500, 30), RatingSystem.ELO)
        unknown = match_quality(
            make_rating(1500, 350), make_rating(1500, 350), RatingSystem.ELO
        )
        assert certain.quality_permille == unknown.quality_permille

    def test_confidence_is_about_both_sides(self) -> None:
        assert match_quality(make_rating(1500, 30), make_rating(1500, 101)).confident is False
        assert match_quality(make_rating(1500, 101), make_rating(1500, 30)).confident is False
        assert match_quality(make_rating(1500, 100), make_rating(1500, 100)).confident is True

    def test_stays_inside_zero_and_one_thousand(self) -> None:
        for left in range(0, 5001, 250):
            for right in range(0, 5001, 250):
                for deviation in (1, 30, 350):
                    for system in RatingSystem:
                        quality = match_quality(
                            make_rating(left, deviation), make_rating(right, deviation), system
                        )
                        assert 0 <= quality.quality_permille <= 1000
                        assert 0 <= quality.win_probability_permille <= 1000


class TestIsAcceptable:
    def test_a_good_match_passes_and_a_bad_one_does_not(self) -> None:
        assert (
            is_acceptable(match_quality(make_rating(1500, 30), make_rating(1500, 30))) is True
        )
        assert (
            is_acceptable(match_quality(make_rating(500, 30), make_rating(3500, 30))) is False
        )

    def test_the_gap_gate_catches_what_the_quality_gate_does_not(self) -> None:
        """Two gates, because they catch different things.

        A pairing between two players the system knows nothing about can score
        acceptably on quality alone. The gap gate is what rejects it.
        """
        quality = match_quality(make_rating(1200, 350), make_rating(1900, 350))
        assert is_acceptable(quality, minimum_quality_permille=0) is True
        assert is_acceptable(quality, minimum_quality_permille=0, maximum_gap=300) is False

    def test_a_widening_queue_relaxes_the_quality_gate(self) -> None:
        quality = match_quality(make_rating(1500, 30), make_rating(1800, 30))
        assert is_acceptable(quality, minimum_quality_permille=900) is False
        assert is_acceptable(quality, minimum_quality_permille=100) is True

    @pytest.mark.parametrize("minimum", [-1, 1001])
    def test_refuses_an_impossible_threshold(self, minimum: int) -> None:
        with pytest.raises(ValidationError):
            is_acceptable(match_quality(make_rating(1500), make_rating(1500)), minimum)


class TestTeamRating:
    def test_a_team_of_one_is_that_player(self) -> None:
        team = team_rating([make_rating(1700, 45, 62_000, 12)])
        assert team.rating == 1700
        assert team.deviation == 45
        assert team.volatility == 62_000
        assert team.matches_played == 12

    def test_the_rating_is_the_mean(self) -> None:
        assert team_rating([make_rating(1000), make_rating(2000)]).rating == 1500
        assert (
            team_rating([make_rating(1000), make_rating(1500), make_rating(2000)]).rating
            == 1500
        )

    def test_the_mean_rounds_half_away_from_zero(self) -> None:
        # Two teams with the same total must come out equal, whichever order
        # the members arrive in.
        assert (
            team_rating([make_rating(1000), make_rating(1001)]).rating
            == team_rating([make_rating(1001), make_rating(1000)]).rating
        )

    def test_deviations_combine_in_quadrature_not_by_averaging(self) -> None:
        """Five uncertain players do not make an uncertain team.

        Their errors partly cancel, and the team is more predictable than any
        of them. Averaging the deviations would say the opposite.
        """
        members = [make_rating(1500, 100) for _ in range(5)]
        team = team_rating(members)
        assert team.deviation == 100  # RMS of five equal values is that value

        mixed = team_rating([make_rating(1500, 30), make_rating(1500, 200)])
        assert 30 < mixed.deviation < 200
        # The RMS is above the arithmetic mean of 115, which is the point.
        assert mixed.deviation > 115

    def test_matches_played_is_the_least_experienced_member(self) -> None:
        # A team is as new as its newest member: that is what decides whether
        # the system should trust the pairing.
        assert (
            team_rating(
                [make_rating(1500, played=3), make_rating(1500, played=500)]
            ).matches_played
            == 3
        )

    def test_refuses_an_empty_team(self) -> None:
        with pytest.raises(ValidationError):
            team_rating([])

    def test_never_returns_a_zero_deviation_or_volatility(self) -> None:
        # Both are divisors elsewhere; a zero would be a crash somewhere far
        # away from here.
        team = team_rating([make_rating(1500, 0, 1, 0), make_rating(1500, 0, 1, 0)])
        assert team.deviation >= 1
        assert team.volatility >= 1


class TestBalanceTeams:
    def test_splits_two_players_one_each(self) -> None:
        split = balance_teams([make_rating(1500), make_rating(1600)])
        assert sorted([*split.left, *split.right]) == [0, 1]
        assert len(split.left) == len(split.right) == 1

    def test_the_first_player_is_always_on_the_left(self) -> None:
        # Each split is considered once rather than twice with the sides
        # swapped, which halves the search and makes the answer stable.
        for size in (2, 4, 6, 8):
            split = balance_teams([make_rating(1000 + index * 100) for index in range(size)])
            assert 0 in split.left

    def test_every_player_is_used_exactly_once(self) -> None:
        for size in (2, 4, 6, 8, 10):
            players = [make_rating(1000 + (index * 373) % 1700) for index in range(size)]
            split = balance_teams(players)
            assert sorted([*split.left, *split.right]) == list(range(size))
            assert len(split.left) == len(split.right) == size // 2

    def test_finds_the_even_split_rather_than_the_obvious_one(self) -> None:
        # 1000, 1000, 2000, 2000 splits evenly only as {1000,2000} against
        # {1000,2000}. A greedy pairing would produce the lopsided one.
        split = balance_teams(
            [
                make_rating(1000, 30),
                make_rating(1000, 30),
                make_rating(2000, 30),
                make_rating(2000, 30),
            ]
        )
        assert sorted(split.left) in ([0, 2], [0, 3])
        assert split.quality.rating_gap == 0

    def test_an_unbalanceable_group_is_still_split(self) -> None:
        split = balance_teams(
            [
                make_rating(500, 30),
                make_rating(500, 30),
                make_rating(500, 30),
                make_rating(3500, 30),
            ]
        )
        assert len(split.left) == 2
        assert split.quality.quality_permille >= 0

    def test_is_deterministic(self) -> None:
        players = [
            make_rating(1000 + (index * 373) % 1700, 40 + index * 7) for index in range(8)
        ]
        first = balance_teams(players)
        for _ in range(3):
            assert balance_teams(players) == first

    @pytest.mark.parametrize("count", [0, 1, 3, 7])
    def test_refuses_an_odd_or_empty_group(self, count: int) -> None:
        with pytest.raises(ValidationError):
            balance_teams([make_rating(1500) for _ in range(count)])

    def test_refuses_more_players_than_it_will_search(self) -> None:
        # Exhaustive is the right algorithm at these sizes; above the cap a
        # caller is building something this function is not for, and returning
        # a slightly wrong answer slowly would be the worst of both.
        with pytest.raises(ValidationError):
            balance_teams([make_rating(1500) for _ in range(22)])
        # The cap itself is accepted.
        assert len(balance_teams([make_rating(1500 + i) for i in range(20)]).left) == 10
