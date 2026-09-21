"""Matchmaking: is this a fair game, and if not, who should play instead.

The library ranks; it does not run a queue. Holding a pool of waiting players,
deciding when to widen the search, talking to a lobby - all of that belongs to
the caller, who already has the players in memory and knows what a queue means
in their product.

What is here is the part that is arithmetic and easy to get wrong: how good a
match is, how likely each side is to win, and how to split a group of players
into two teams that are as close as they can be made.
"""

from __future__ import annotations

from dataclasses import dataclass

from .constants import PERMILLE_ONE
from .errors import ValidationError
from .fixed import SCALE, fixed_div, fixed_sqrt
from .rating import Rating, RatingSystem, expected_score_permille

__all__ = [
    "MatchQuality",
    "match_quality",
    "team_rating",
    "balance_teams",
    "TeamSplit",
    "is_acceptable",
]


@dataclass(frozen=True)
class MatchQuality:
    """How good a proposed match is."""

    #: 0..1000. A thousand is a coin toss between two equally certain players;
    #: zero is a foregone conclusion.
    quality_permille: int
    #: The chance the first side wins, in permille.
    win_probability_permille: int
    #: The rating gap, in points. Signed: positive means the first side is
    #: stronger.
    rating_gap: int
    #: True when both sides are certain enough for the quality figure to mean
    #: something. A match between two players the system knows nothing about
    #: scores well and tells you nothing.
    confident: bool


def match_quality(
    left: Rating,
    right: Rating,
    system: RatingSystem = RatingSystem.GLICKO2,
) -> MatchQuality:
    """How even a match between two players would be.

    Quality is highest when the expected score is closest to even, and it falls
    away as the match becomes predictable. The relationship is deliberately not
    linear: an expected score of 550 is a good match, 650 is a mediocre one and
    750 is not worth playing, and a linear scale would call the last of those
    "half quality".

    Under Glicko-2 the two deviations widen the answer: pairing two players the
    system is unsure about is a *worse* match than the ratings suggest, because
    the ratings might be wrong. ``confident`` says whether that is the case.

    **The answer does not depend on which side the caller listed first**, and
    that needs saying because it does not come for free. Glicko-2's expected
    score damps by the *opponent's* deviation, so the two directions are two
    different calculations that agree to within a rounding step - and the
    quality is quadratic in the imbalance, which turns that one permille into
    three. A queue that got a different verdict depending on the order it
    happened to hold two players in would be a queue with a bug nobody could
    reproduce, so the expectation is evaluated in a fixed order and flipped
    afterwards if the caller asked the other way round.
    """
    flipped = _canonical_order(left, right)
    first, second = (right, left) if flipped else (left, right)

    canonical = expected_score_permille(first, second, system)
    probability = PERMILLE_ONE - canonical if flipped else canonical

    # Distance from an even match, 0..500. Taken from the canonical direction,
    # which is what makes it identical for both orderings.
    imbalance = abs(canonical - PERMILLE_ONE // 2)
    # Quality falls with the square of the imbalance, normalised so that an
    # even match is 1000 and a certain one is 0.
    quality = PERMILLE_ONE - (imbalance * imbalance * 4) // PERMILLE_ONE

    if system is RatingSystem.GLICKO2:
        # Uncertainty discounts the quality: a match that looks even between
        # two unknowns is a guess, not a good pairing.
        combined = left.deviation + right.deviation
        # At two full newcomer deviations the quality is halved.
        penalty = min(PERMILLE_ONE // 2, (combined * PERMILLE_ONE) // (4 * 350))
        quality = (quality * (PERMILLE_ONE - penalty)) // PERMILLE_ONE

    confident = left.deviation <= 100 and right.deviation <= 100

    return MatchQuality(
        quality_permille=max(0, min(PERMILLE_ONE, quality)),
        win_probability_permille=probability,
        rating_gap=left.rating - right.rating,
        confident=confident,
    )


def _canonical_order(left: Rating, right: Rating) -> bool:
    """Whether the pair should be evaluated the other way round.

    Any total order will do; this one is by rating, then by the fields that
    break a tie, and it is written out rather than left to a tuple comparison
    because the TypeScript edition has no tuple comparison to agree with.
    """
    if left.rating != right.rating:
        return left.rating > right.rating
    if left.deviation != right.deviation:
        return left.deviation > right.deviation
    if left.volatility != right.volatility:
        return left.volatility > right.volatility
    return left.matches_played > right.matches_played


def is_acceptable(
    quality: MatchQuality,
    minimum_quality_permille: int = 400,
    maximum_gap: int | None = None,
) -> bool:
    """Whether a match is good enough to run.

    Two gates rather than one, because they catch different things. The quality
    gate rejects a mismatch; the rating gap gate rejects a pairing that scores
    well only because both players are uncertain. A queue that widens over time
    relaxes the first and keeps the second.
    """
    if not 0 <= minimum_quality_permille <= PERMILLE_ONE:
        raise ValidationError(
            "minimum_quality_permille must be between 0 and 1000",
            minimum_quality_permille=minimum_quality_permille,
        )
    if quality.quality_permille < minimum_quality_permille:
        return False
    return maximum_gap is None or abs(quality.rating_gap) <= maximum_gap


def team_rating(members: list[Rating]) -> Rating:
    """One rating that stands in for a team.

    The mean rating, and the deviations combined the way independent
    uncertainties combine - the root of the mean of the squares, not the mean.
    Averaging deviations would say that five uncertain players make an
    uncertain team; in fact their errors partly cancel, and the team is more
    predictable than any of them.
    """
    if not members:
        raise ValidationError("A team needs at least one member")

    total = sum(member.rating for member in members)
    count = len(members)
    # Round half away from zero so two teams of the same total are equal.
    mean = (
        (total * 2 + count) // (2 * count)
        if total >= 0
        else -((-total * 2 + count) // (2 * count))
    )

    variance = sum(member.deviation * member.deviation for member in members)
    deviation = fixed_sqrt(fixed_div(variance * SCALE, count * SCALE))
    deviation_points = (deviation + SCALE // 2) // SCALE

    volatility = sum(member.volatility for member in members) // count
    matches = min(member.matches_played for member in members)

    return Rating(
        rating=mean,
        deviation=max(1, deviation_points),
        volatility=max(1, volatility),
        matches_played=matches,
    )


@dataclass(frozen=True)
class TeamSplit:
    """Two teams, and how even the result is."""

    #: Indices into the input list, not the ratings themselves - the caller
    #: knows which player each index is and this module deliberately does not.
    left: tuple[int, ...]
    right: tuple[int, ...]
    quality: MatchQuality


def balance_teams(
    players: list[Rating],
    system: RatingSystem = RatingSystem.GLICKO2,
) -> TeamSplit:
    """Split an even number of players into the two closest teams.

    Exhaustive over every split, which is the right algorithm for the sizes
    that matter: ten players is 126 distinct splits, and a heuristic that is
    fast on ten players buys nothing while occasionally producing a worse team
    than the obvious one.

    The search is capped at 20 players (92,378 splits). Above that a caller is
    building something this function is not for, and returning a slightly wrong
    answer slowly would be the worst of both.
    """
    count = len(players)
    if count < 2 or count % 2 != 0:
        raise ValidationError(
            "balance_teams needs an even number of players, at least two",
            count=count,
        )
    if count > 20:
        raise ValidationError(
            "balance_teams is exhaustive and capped at 20 players",
            count=count,
        )

    half = count // 2
    best: TeamSplit | None = None

    # Every subset of size `half` that contains player 0, so each split is
    # considered once rather than twice with the sides swapped.
    for mask in range(1 << count):
        if mask & 1 == 0:
            continue
        if _popcount(mask) != half:
            continue
        left_indices = tuple(i for i in range(count) if mask & (1 << i))
        right_indices = tuple(i for i in range(count) if not mask & (1 << i))
        quality = match_quality(
            team_rating([players[i] for i in left_indices]),
            team_rating([players[i] for i in right_indices]),
            system,
        )
        if best is None or quality.quality_permille > best.quality.quality_permille:
            best = TeamSplit(left=left_indices, right=right_indices, quality=quality)

    assert best is not None  # the loop always finds at least one split
    return best


def _popcount(value: int) -> int:
    """How many bits are set. Written out because JavaScript has no ``bit_count``."""
    count = 0
    while value:
        value &= value - 1
        count += 1
    return count
