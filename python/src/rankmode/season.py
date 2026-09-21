"""Seasons: the ladder starts again, without starting from nothing.

A competitive ladder that never resets stops being competitive. The top settles
into the people who played earliest, a newcomer cannot reach the top bracket
inside a year, and a player who stopped a season ago still occupies a place.

A ladder that resets *completely* is worse. Everybody plays their placements
against strangers, the matchmaker knows nothing about anybody for a week, and
the player who spent four months reaching Diamond opens the game to find they
are Silver again.

So the reset is **soft**: the rating is pulled towards the middle by a fraction,
and the uncertainty is widened so the first few matches of the new season count
for more. A strong player lands high and confirms it in five matches; a weak
one lands low and does the same. Nobody starts from nothing, and nobody keeps a
place they can no longer hold.

Everything here is a pure function of a state and a season definition. Nothing
reads a clock: a season boundary is a timestamp the caller passes in, because a
library that decided for itself when a season ended could not be tested.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .constants import PERMILLE_ONE
from .errors import ConfigurationError, SeasonError, ValidationError
from .ladder import LadderConfig, LadderPosition, position_for_rating
from .rating import DEFAULT_DEVIATION, DEFAULT_RATING, Rating

__all__ = [
    "Season",
    "ResetPolicy",
    "SeasonResetConfig",
    "SeasonSummary",
    "reset_rating",
    "reset_position",
    "season_for",
    "is_within",
]


class ResetPolicy(str, Enum):
    """How hard the reset pulls."""

    #: Nothing changes. For a ladder whose season is a label rather than a
    #: restart - a leaderboard that is archived and continues.
    NONE = "NONE"
    #: The rating moves a fraction of the way towards the mean, and the
    #: deviation widens. The default, and what almost every ladder wants.
    SOFT = "SOFT"
    #: Everybody returns to the starting rating with full uncertainty. Honest,
    #: brutal, and worth it only when the population or the rules changed
    #: enough that last season's numbers mean nothing.
    HARD = "HARD"


@dataclass(frozen=True)
class Season:
    """One competitive period.

    ``starts_at`` and ``ends_at`` are epoch milliseconds, like every other
    timestamp in this library. ``ends_at`` may be ``None`` for the season that
    is running now and has no announced end.
    """

    #: Stable identifier. Stored alongside a player's state so that a state
    #: from an older season can be recognised and reset rather than trusted.
    id: str
    #: Human name, for display.
    name: str
    starts_at: int
    ends_at: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not self.id:
            raise ConfigurationError("A season needs a non-empty id", id=self.id)
        if not isinstance(self.starts_at, int) or isinstance(self.starts_at, bool):
            raise ConfigurationError(
                "starts_at must be an epoch-millisecond integer", starts_at=self.starts_at
            )
        if self.ends_at is not None:
            if not isinstance(self.ends_at, int) or isinstance(self.ends_at, bool):
                raise ConfigurationError(
                    "ends_at must be an epoch-millisecond integer or None",
                    ends_at=self.ends_at,
                )
            if self.ends_at <= self.starts_at:
                raise SeasonError(
                    "A season cannot end before it begins",
                    starts_at=self.starts_at,
                    ends_at=self.ends_at,
                )

    def contains(self, timestamp: int) -> bool:
        """True when the timestamp falls inside this season."""
        if timestamp < self.starts_at:
            return False
        return self.ends_at is None or timestamp < self.ends_at


@dataclass(frozen=True)
class SeasonResetConfig:
    """How much of last season a player keeps.

    The defaults describe the soft reset most ladders converge on after trying
    the alternatives: pull halfway to the mean, widen the uncertainty to about
    half of a newcomer's, and never let anybody land more than one tier above
    where their rating says they belong.
    """

    policy: ResetPolicy = ResetPolicy.SOFT
    #: How far towards the mean the rating moves, in permille. 500 is halfway.
    #: 0 keeps the rating exactly; 1000 is a hard reset by another name.
    pull_permille: int = 500
    #: The rating the pull moves towards.
    mean_rating: int = DEFAULT_RATING
    #: The deviation every player starts the season with, in rating points.
    #: Half a newcomer's, so the first matches count for more without the
    #: swings being wild.
    reset_deviation: int = DEFAULT_DEVIATION // 2
    #: Whether the volatility carries over. It usually should: a player whose
    #: results were erratic last season is likely to be erratic this season,
    #: and that is information worth keeping.
    keep_volatility: bool = True
    #: Matches played resets to zero, so that placements happen again. Set to
    #: False for a ladder where placements are a one-time event per account.
    reset_matches_played: bool = True

    def __post_init__(self) -> None:
        if not 0 <= self.pull_permille <= PERMILLE_ONE:
            raise ConfigurationError(
                "pull_permille must be between 0 and 1000",
                pull_permille=self.pull_permille,
            )
        if self.reset_deviation <= 0:
            raise ConfigurationError(
                "reset_deviation must be positive", reset_deviation=self.reset_deviation
            )


def reset_rating(rating: Rating, config: SeasonResetConfig | None = None) -> Rating:
    """Carry a rating into a new season.

    Under ``SOFT`` the rating moves a fraction of the way to the mean and the
    deviation is set to the season's starting value. The arithmetic is integer
    throughout, and the rounding is half away from zero so that a player above
    the mean and one equally far below move by the same amount.
    """
    settings = config if config is not None else SeasonResetConfig()

    if settings.policy is ResetPolicy.NONE:
        return rating

    if settings.policy is ResetPolicy.HARD:
        return Rating(
            rating=settings.mean_rating,
            deviation=DEFAULT_DEVIATION,
            volatility=rating.volatility if settings.keep_volatility else Rating().volatility,
            matches_played=0 if settings.reset_matches_played else rating.matches_played,
        )

    distance = settings.mean_rating - rating.rating
    moved = distance * settings.pull_permille
    if moved >= 0:
        shift = (moved + PERMILLE_ONE // 2) // PERMILLE_ONE
    else:
        shift = -((-moved + PERMILLE_ONE // 2) // PERMILLE_ONE)

    return Rating(
        rating=rating.rating + shift,
        deviation=settings.reset_deviation,
        volatility=rating.volatility if settings.keep_volatility else Rating().volatility,
        matches_played=0 if settings.reset_matches_played else rating.matches_played,
    )


def reset_position(
    rating: Rating,
    reset: SeasonResetConfig | None = None,
    ladder: LadderConfig | None = None,
) -> LadderPosition:
    """Where a player starts the new season on the ladder.

    Derived from the reset rating rather than carried over from last season's
    bracket, because the bracket is a display of the rating and the rating just
    moved. Carrying the bracket instead is how a ladder ends up with a Diamond
    player whose rating says Gold.
    """
    return position_for_rating(reset_rating(rating, reset).rating, ladder)


@dataclass(frozen=True)
class SeasonSummary:
    """What a player did in a season, for rewards and for the record.

    ``peak_position`` is the thing rewards are almost always based on, and it
    is deliberately not the *final* position: a player who reached Diamond in
    March and slipped to Platinum in May earned the Diamond reward. Basing
    rewards on the final standing instead teaches players to stop playing once
    they reach their target, which is the opposite of what a ladder is for.
    """

    season_id: str
    matches_played: int
    wins: int
    losses: int
    draws: int
    peak_rating: int
    final_rating: int
    peak_position: LadderPosition | None = None
    final_position: LadderPosition | None = None

    @property
    def win_rate_permille(self) -> int:
        """Wins as a share of decided matches, in permille.

        Draws are excluded from the denominator rather than counted as half a
        win: a win rate is read as "how often do I win when it is decided", and
        a ladder with many draws would otherwise show everybody at 500.
        """
        decided = self.wins + self.losses
        if decided == 0:
            return 0
        return (self.wins * PERMILLE_ONE) // decided


def season_for(seasons: list[Season], timestamp: int) -> Season | None:
    """Which season a timestamp falls in, or ``None`` between two.

    A gap between seasons is a normal thing - the week where last season is
    over and the next has not begun - and it is not an error. What a caller
    does with ``None`` is their decision: most show last season's result and
    refuse ranked matches.
    """
    if not isinstance(timestamp, int) or isinstance(timestamp, bool):
        raise ValidationError("timestamp must be an integer", timestamp=timestamp)
    for season in seasons:
        if season.contains(timestamp):
            return season
    return None


def is_within(season: Season, timestamp: int) -> bool:
    """True when the timestamp is inside the season."""
    return season.contains(timestamp)
