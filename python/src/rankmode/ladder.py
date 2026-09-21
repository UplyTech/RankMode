"""The ladder: the rank a player actually sees.

A rating is a number between 0 and 5000 with a deviation attached. Nobody wants
to be told they are 1847 give or take 63. They want to be told they are Gold II,
and they want to know how far it is to Gold I.

This module is that translation, and it is deliberately separate from
:mod:`rankmode.rating`. The two answer different questions:

===============  ==========================================================
``rating``       what the matchmaker uses. Moves on every match, by the
                 amount the maths says, and is never rounded for effect.
``ladder``       what the player sees. Moves in whole League Points, has
                 floors that stop a bad evening from undoing a month, and
                 makes promotion feel like an event.
===============  ==========================================================

Keeping them apart is what lets the matchmaker be honest while the display is
kind. A system that has only one of the two either shows the player a number
that jitters after every match, or matches them against opponents chosen by a
number that has been smoothed for their feelings.

**Nothing here is random and nothing here reads a clock.** A ladder position
follows from a rating and a stored state, and the same inputs give the same
answer in both editions - which is what the shared vectors check.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum

from .constants import PERMILLE_ONE
from .errors import ConfigurationError, LadderError, ValidationError

__all__ = [
    "Tier",
    "Division",
    "LadderPosition",
    "LadderConfig",
    "SeriesState",
    "default_tiers",
    "position_for_rating",
    "rating_for_position",
    "compare_positions",
    "format_position",
    "apply_league_points",
    "LadderChange",
    "LadderOutcome",
]


class Tier(str, Enum):
    """The named bands of the ladder, lowest first.

    Nine of them, because that is what a population of any size needs: fewer
    and the middle is a single enormous bucket where nobody can see progress,
    more and the names stop meaning anything.

    The top three are **apex tiers**. They have no divisions - a player there is
    ranked against everybody else at that level by League Points alone, and the
    ladder position is a number, not a bracket.
    """

    IRON = "IRON"
    BRONZE = "BRONZE"
    SILVER = "SILVER"
    GOLD = "GOLD"
    PLATINUM = "PLATINUM"
    DIAMOND = "DIAMOND"
    MASTER = "MASTER"
    GRANDMASTER = "GRANDMASTER"
    CHALLENGER = "CHALLENGER"

    @property
    def order(self) -> int:
        """Position in the ladder, zero for the lowest tier.

        Not called ``index``, which is the obvious name and the wrong one:
        :class:`Tier` derives from :class:`str`, so an ``index`` property
        shadows ``str.index`` with something that is not callable, and
        ``Tier.GOLD.index("O")`` becomes a ``TypeError`` instead of a number.
        """
        return _TIER_ORDER.index(self)

    @property
    def is_apex(self) -> bool:
        """True for the tiers that have no divisions."""
        return self in _APEX_TIERS


_TIER_ORDER: tuple[Tier, ...] = (
    Tier.IRON,
    Tier.BRONZE,
    Tier.SILVER,
    Tier.GOLD,
    Tier.PLATINUM,
    Tier.DIAMOND,
    Tier.MASTER,
    Tier.GRANDMASTER,
    Tier.CHALLENGER,
)

_APEX_TIERS: frozenset[Tier] = frozenset({Tier.MASTER, Tier.GRANDMASTER, Tier.CHALLENGER})


class Division(int, Enum):
    """The sub-bands inside a tier, hardest last.

    Numbered downwards the way every ladder numbers them: a player climbs from
    IV to I and then out of the tier. The integer values run the other way so
    that a larger number is a better position, which is what every comparison
    in this module wants.
    """

    FOUR = 1
    THREE = 2
    TWO = 3
    ONE = 4

    @property
    def label(self) -> str:
        """The Roman numeral a player sees."""
        return {1: "IV", 2: "III", 3: "II", 4: "I"}[self.value]


class LadderOutcome(str, Enum):
    """What a change in League Points did to the player's position."""

    #: Points moved, the bracket did not.
    UNCHANGED = "UNCHANGED"
    #: Up a division inside the same tier.
    PROMOTED_DIVISION = "PROMOTED_DIVISION"
    #: Up into the next tier.
    PROMOTED_TIER = "PROMOTED_TIER"
    #: Down a division inside the same tier.
    DEMOTED_DIVISION = "DEMOTED_DIVISION"
    #: Down into the tier below.
    DEMOTED_TIER = "DEMOTED_TIER"
    #: The player reached 100 points and a promotion series began.
    SERIES_STARTED = "SERIES_STARTED"
    #: A series match was won or lost, and the series is still running.
    SERIES_ADVANCED = "SERIES_ADVANCED"
    #: The series was lost; the player stays where they are.
    SERIES_FAILED = "SERIES_FAILED"
    #: Points would have fallen below zero but a floor held them.
    FLOOR_HELD = "FLOOR_HELD"


@dataclass(frozen=True)
class SeriesState:
    """A promotion series in progress.

    A series is a best-of-N at the boundary of a tier. It exists because a
    single lucky match should not move somebody into a bracket they cannot hold,
    and because arriving in a new tier feels like something when it was earned
    over several games.

    ``wins`` and ``losses`` count the series so far. It ends when either
    reaches its target.
    """

    #: Matches that must be won to pass.
    wins_needed: int
    #: Matches that may be lost before the series fails.
    losses_allowed: int
    wins: int = 0
    losses: int = 0

    def __post_init__(self) -> None:
        if self.wins_needed <= 0:
            raise ConfigurationError(
                "wins_needed must be positive", wins_needed=self.wins_needed
            )
        if self.losses_allowed < 0:
            raise ConfigurationError(
                "losses_allowed cannot be negative", losses_allowed=self.losses_allowed
            )
        if self.wins < 0 or self.losses < 0:
            raise ValidationError("A series cannot have negative results")

    @property
    def is_won(self) -> bool:
        """True once enough matches have been won."""
        return self.wins >= self.wins_needed

    @property
    def is_lost(self) -> bool:
        """True once too many have been lost."""
        return self.losses > self.losses_allowed

    @property
    def is_over(self) -> bool:
        return self.is_won or self.is_lost


@dataclass(frozen=True)
class LadderPosition:
    """Where a player stands, as a player would describe it.

    ``division`` is ``None`` in an apex tier, where there are no divisions and
    the League Points are an open-ended ladder score rather than a bracket.
    """

    tier: Tier
    division: Division | None
    #: League Points inside the current bracket, 0..99 below apex, unbounded above.
    league_points: int
    #: A promotion series, if one is running.
    series: SeriesState | None = None

    def __post_init__(self) -> None:
        if self.tier.is_apex and self.division is not None:
            raise LadderError("An apex tier has no divisions", tier=self.tier.value)
        if not self.tier.is_apex and self.division is None:
            raise LadderError("A tier below apex needs a division", tier=self.tier.value)
        if self.league_points < 0:
            raise ValidationError(
                "League points cannot be negative", league_points=self.league_points
            )


def default_tiers() -> tuple[Tier, ...]:
    """Every tier, lowest first."""
    return _TIER_ORDER


@dataclass(frozen=True)
class LadderConfig:
    """How ratings map onto the ladder, and how points move.

    The defaults describe a ladder that behaves the way players expect one to.
    Every one of them is a decision, and the ones that are not obvious carry
    their reason.
    """

    #: The rating at which each tier begins, lowest first. Nine entries, one
    #: per tier. Below the first entry a player is still in the lowest tier.
    tier_thresholds: tuple[int, ...] = (0, 800, 1100, 1400, 1700, 2000, 2300, 2600, 2900)
    #: Points needed to leave a division.
    points_per_division: int = 100
    #: The base League Points a win is worth. The actual amount is adjusted by
    #: how far the player's rating is from their displayed bracket, so that
    #: somebody under-ranked climbs faster than somebody over-ranked.
    base_points_gain: int = 20
    #: The base League Points a loss costs.
    base_points_loss: int = 18
    #: How far the gain may be adjusted, in permille of the base. 500 means a
    #: win is worth between half and one and a half times the base.
    adjustment_span_permille: int = 500
    #: Matches to win in a promotion series, and losses allowed.
    series_wins_needed: int = 3
    #: ``0`` disables promotion series entirely - some ladders are better
    #: without them, and forcing one on a small community makes every promotion
    #: take a week.
    series_losses_allowed: int = 2
    #: Whether a series is required to leave a tier. Division promotions inside
    #: a tier never use one: they happen too often for a ceremony.
    series_on_tier_promotion: bool = True
    #: A player who has just been promoted cannot be demoted for this many
    #: matches. Without it a promotion at 0 points is undone by the next loss,
    #: which reads as a bug even though it is arithmetic.
    demotion_protection_matches: int = 3
    #: Whether a player can fall out of a tier at all. Some ladders lock the
    #: tier once reached for a season; that is what ``False`` means.
    allow_tier_demotion: bool = True
    #: The lowest tier a player can fall to once they have reached it, by tier
    #: index. ``None`` means no floor.
    tier_floor: Tier | None = None

    def __post_init__(self) -> None:
        if len(self.tier_thresholds) != len(_TIER_ORDER):
            raise ConfigurationError(
                "tier_thresholds needs one entry per tier",
                expected=len(_TIER_ORDER),
                given=len(self.tier_thresholds),
            )
        for index in range(1, len(self.tier_thresholds)):
            if self.tier_thresholds[index] <= self.tier_thresholds[index - 1]:
                raise ConfigurationError(
                    "tier_thresholds must ascend strictly",
                    index=index,
                    previous=self.tier_thresholds[index - 1],
                    current=self.tier_thresholds[index],
                )
        if self.points_per_division <= 0:
            raise ConfigurationError(
                "points_per_division must be positive",
                points_per_division=self.points_per_division,
            )
        for name in ("base_points_gain", "base_points_loss"):
            value = getattr(self, name)
            if value < 0:
                raise ConfigurationError(f"{name} cannot be negative", **{name: value})
        if not 0 <= self.adjustment_span_permille <= PERMILLE_ONE:
            raise ConfigurationError(
                "adjustment_span_permille must be between 0 and 1000",
                adjustment_span_permille=self.adjustment_span_permille,
            )
        if self.demotion_protection_matches < 0:
            raise ConfigurationError(
                "demotion_protection_matches cannot be negative",
                demotion_protection_matches=self.demotion_protection_matches,
            )

    @property
    def uses_series(self) -> bool:
        """True when promotion series are switched on at all."""
        return self.series_on_tier_promotion and self.series_wins_needed > 0


def position_for_rating(rating: int, config: LadderConfig | None = None) -> LadderPosition:
    """The bracket a rating corresponds to, ignoring any stored progress.

    This is the seeding function: it answers "where does this rating belong?"
    for a player who has no ladder history - after placements, after a season
    reset, or when a caller wants to show what a rating is worth without
    carrying the ladder state around.

    A player's *actual* position comes from their stored state, because a
    ladder deliberately lags a rating. Use :func:`apply_league_points` for that.
    """
    settings = config if config is not None else LadderConfig()
    if not isinstance(rating, int) or isinstance(rating, bool):
        raise ValidationError("rating must be an integer", rating=rating)

    tier_index = 0
    for index, threshold in enumerate(settings.tier_thresholds):
        if rating >= threshold:
            tier_index = index
        else:
            break
    tier = _TIER_ORDER[tier_index]

    if tier.is_apex:
        # Above apex the League Points are the ladder: one point per rating
        # point above the threshold, so the ordering is the rating's ordering.
        return LadderPosition(
            tier=tier,
            division=None,
            league_points=max(0, rating - settings.tier_thresholds[tier_index]),
        )

    span = settings.tier_thresholds[tier_index + 1] - settings.tier_thresholds[tier_index]
    # Clamped at zero, and that clamp is load-bearing. A rating below the
    # lowest threshold is a perfectly ordinary input - the floor is
    # configurable, and a caller is free to hand this function a number from
    # anywhere - but the difference is then negative, floor division sends the
    # division index to -1, and ``Division(0)`` does not exist. The right
    # answer for somebody below the bottom of the ladder is the bottom of the
    # ladder.
    into_tier = max(0, rating - settings.tier_thresholds[tier_index])
    # Four divisions across the tier's rating span.
    division_size = span // 4
    if division_size <= 0:
        division_index = 0
        points = 0
    else:
        division_index = max(0, min(3, into_tier // division_size))
        into_division = into_tier - division_index * division_size
        points = (into_division * settings.points_per_division) // division_size
        points = max(0, min(settings.points_per_division - 1, points))

    return LadderPosition(
        tier=tier,
        division=Division(division_index + 1),
        league_points=points,
    )


def rating_for_position(position: LadderPosition, config: LadderConfig | None = None) -> int:
    """The rating a bracket corresponds to.

    The inverse of :func:`position_for_rating`, to the precision a bracket can
    carry. Used when a season reset has to turn a displayed rank back into a
    rating, and by the tests, which check that the round trip lands in the same
    bracket it started in.
    """
    settings = config if config is not None else LadderConfig()
    tier_index = position.tier.order
    base = settings.tier_thresholds[tier_index]

    if position.tier.is_apex:
        return base + position.league_points

    span = settings.tier_thresholds[tier_index + 1] - base
    division_size = span // 4
    division_index = (position.division.value if position.division else 1) - 1
    into = division_index * division_size
    into += (position.league_points * division_size) // settings.points_per_division
    return base + into


def compare_positions(left: LadderPosition, right: LadderPosition) -> int:
    """``-1``, ``0`` or ``1``: which of two positions is higher.

    Tier first, then division, then points. Written out rather than left to a
    tuple comparison because the two editions have to agree about it, and
    JavaScript has no tuple comparison to agree with.
    """
    if left.tier.order != right.tier.order:
        return -1 if left.tier.order < right.tier.order else 1

    left_division = left.division.value if left.division else 0
    right_division = right.division.value if right.division else 0
    if left_division != right_division:
        return -1 if left_division < right_division else 1

    if left.league_points != right.league_points:
        return -1 if left.league_points < right.league_points else 1
    return 0


def format_position(position: LadderPosition) -> str:
    """The position as a player would read it: ``"Gold II, 47 LP"``."""
    name = position.tier.value.capitalize()
    if position.division is None:
        return f"{name}, {position.league_points} LP"
    return f"{name} {position.division.label}, {position.league_points} LP"


@dataclass(frozen=True)
class LadderChange:
    """What one match did to a ladder position."""

    outcome: LadderOutcome
    previous: LadderPosition
    current: LadderPosition
    #: League Points gained or lost. Signed.
    points_delta: int
    #: True when the tier changed in either direction.
    tier_changed: bool
    #: True when this match started, advanced or ended a promotion series.
    series_active: bool


def apply_league_points(
    position: LadderPosition,
    won: bool,
    rating: int,
    config: LadderConfig | None = None,
    matches_since_promotion: int = 999,
) -> LadderChange:
    """Move a player up or down the ladder by one match.

    The amount is the base gain or loss, adjusted by how far the player's
    rating has drifted from the bracket they are displayed in. A player whose
    rating says Platinum while their bracket says Gold gains more per win and
    loses less per loss, and so climbs to where they belong within a few
    matches instead of a few dozen. That adjustment is the entire reason the
    rating and the ladder are separate numbers.
    """
    settings = config if config is not None else LadderConfig()

    delta = _points_delta(position, won, rating, settings)

    # A promotion series in progress takes precedence: points do not move
    # during one, only the series record does.
    if position.series is not None and not position.series.is_over:
        return _advance_series(position, won, settings)

    points = position.league_points + delta

    if won:
        return _handle_gain(position, points, delta, settings)
    return _handle_loss(position, points, delta, settings, matches_since_promotion)


def _points_delta(
    position: LadderPosition, won: bool, rating: int, settings: LadderConfig
) -> int:
    """The signed League Point change for one match."""
    base = settings.base_points_gain if won else -settings.base_points_loss
    if settings.adjustment_span_permille == 0:
        return base

    # How far the rating is from the middle of the displayed bracket, measured
    # in divisions. Positive means under-ranked: the rating is above the
    # bracket, so the player should climb faster.
    expected = rating_for_position(position, settings)
    tier_index = position.tier.order
    if position.tier.is_apex:
        span = max(1, settings.points_per_division)
    else:
        span = max(
            1,
            (settings.tier_thresholds[tier_index + 1] - settings.tier_thresholds[tier_index])
            // 4,
        )
    drift_permille = ((rating - expected) * PERMILLE_ONE) // span
    # Clamp to the configured span, so a wildly wrong rating cannot make a
    # single match worth a whole division.
    limit = settings.adjustment_span_permille
    drift_permille = max(-limit, min(limit, drift_permille))

    if won:
        adjusted = base * (PERMILLE_ONE + drift_permille)
    else:
        # Under-ranked players lose less; over-ranked lose more.
        adjusted = base * (PERMILLE_ONE - drift_permille)

    # Round away from zero so a match is always worth at least one point.
    if adjusted >= 0:
        result = (adjusted + PERMILLE_ONE // 2) // PERMILLE_ONE
        return max(1, result) if won else result
    result = -((-adjusted + PERMILLE_ONE // 2) // PERMILLE_ONE)
    return min(-1, result) if not won else result


def _handle_gain(
    position: LadderPosition, points: int, delta: int, settings: LadderConfig
) -> LadderChange:
    """A win that may cross a division or tier boundary."""
    if position.tier.is_apex:
        # No brackets above apex: the points simply accumulate.
        return LadderChange(
            outcome=LadderOutcome.UNCHANGED,
            previous=position,
            current=replace(position, league_points=points),
            points_delta=delta,
            tier_changed=False,
            series_active=False,
        )

    if points < settings.points_per_division:
        return LadderChange(
            outcome=LadderOutcome.UNCHANGED,
            previous=position,
            current=replace(position, league_points=points),
            points_delta=delta,
            tier_changed=False,
            series_active=False,
        )

    division = position.division or Division.FOUR
    leaving_tier = division is Division.ONE

    if leaving_tier and settings.uses_series:
        series = SeriesState(
            wins_needed=settings.series_wins_needed,
            losses_allowed=settings.series_losses_allowed,
        )
        return LadderChange(
            outcome=LadderOutcome.SERIES_STARTED,
            previous=position,
            current=replace(
                position, league_points=settings.points_per_division, series=series
            ),
            points_delta=delta,
            tier_changed=False,
            series_active=True,
        )

    if leaving_tier:
        return _promote_tier(position, points - settings.points_per_division, delta, settings)

    return LadderChange(
        outcome=LadderOutcome.PROMOTED_DIVISION,
        previous=position,
        current=LadderPosition(
            tier=position.tier,
            division=Division(division.value + 1),
            league_points=points - settings.points_per_division,
        ),
        points_delta=delta,
        tier_changed=False,
        series_active=False,
    )


def _promote_tier(
    position: LadderPosition, carry: int, delta: int, settings: LadderConfig
) -> LadderChange:
    """Move into the next tier, carrying the surplus points."""
    next_index = position.tier.order + 1
    if next_index >= len(_TIER_ORDER):
        # Already at the top of the ladder; the points stay where they are.
        return LadderChange(
            outcome=LadderOutcome.UNCHANGED,
            previous=position,
            current=replace(position, league_points=settings.points_per_division - 1),
            points_delta=delta,
            tier_changed=False,
            series_active=False,
        )

    next_tier = _TIER_ORDER[next_index]
    return LadderChange(
        outcome=LadderOutcome.PROMOTED_TIER,
        previous=position,
        current=LadderPosition(
            tier=next_tier,
            division=None if next_tier.is_apex else Division.FOUR,
            league_points=carry,
        ),
        points_delta=delta,
        tier_changed=True,
        series_active=False,
    )


def _handle_loss(
    position: LadderPosition,
    points: int,
    delta: int,
    settings: LadderConfig,
    matches_since_promotion: int,
) -> LadderChange:
    """A loss that may cross a division or tier boundary downwards."""
    if points >= 0:
        return LadderChange(
            outcome=LadderOutcome.UNCHANGED,
            previous=position,
            current=replace(position, league_points=points),
            points_delta=delta,
            tier_changed=False,
            series_active=False,
        )

    if position.tier.is_apex:
        # Falling below the apex threshold drops out of the apex tier.
        if position.tier.order == 0 or not settings.allow_tier_demotion:
            return _floor_held(position, delta)
        return _demote_tier(position, delta, settings)

    protected = matches_since_promotion < settings.demotion_protection_matches
    division = position.division or Division.FOUR

    if division is not Division.FOUR:
        if protected:
            return _floor_held(position, delta)
        return LadderChange(
            outcome=LadderOutcome.DEMOTED_DIVISION,
            previous=position,
            current=LadderPosition(
                tier=position.tier,
                division=Division(division.value - 1),
                league_points=settings.points_per_division + points,
            ),
            points_delta=delta,
            tier_changed=False,
            series_active=False,
        )

    # At the bottom division of a tier: this is a tier demotion, if allowed.
    if not settings.allow_tier_demotion or protected:
        return _floor_held(position, delta)
    if settings.tier_floor is not None and position.tier.order <= settings.tier_floor.order:
        return _floor_held(position, delta)
    if position.tier.order == 0:
        return _floor_held(position, delta)

    return _demote_tier(position, delta, settings)


def _demote_tier(position: LadderPosition, delta: int, settings: LadderConfig) -> LadderChange:
    """Drop into the tier below, landing near its top."""
    lower = _TIER_ORDER[position.tier.order - 1]
    return LadderChange(
        outcome=LadderOutcome.DEMOTED_TIER,
        previous=position,
        current=LadderPosition(
            tier=lower,
            division=None if lower.is_apex else Division.ONE,
            # Landing at 75 rather than 99 so that one win does not immediately
            # start another promotion series: a player bouncing on a tier
            # boundary every other match is the worst experience a ladder has.
            league_points=(settings.points_per_division * 3) // 4,
        ),
        points_delta=delta,
        tier_changed=True,
        series_active=False,
    )


def _floor_held(position: LadderPosition, delta: int) -> LadderChange:
    """A loss that would have demoted, held at zero points."""
    return LadderChange(
        outcome=LadderOutcome.FLOOR_HELD,
        previous=position,
        current=replace(position, league_points=0),
        points_delta=delta,
        tier_changed=False,
        series_active=False,
    )


def _advance_series(
    position: LadderPosition, won: bool, settings: LadderConfig
) -> LadderChange:
    """One match inside a promotion series."""
    series = position.series
    assert series is not None  # guarded by the caller
    updated = replace(
        series,
        wins=series.wins + (1 if won else 0),
        losses=series.losses + (0 if won else 1),
    )

    if updated.is_won:
        promoted = _promote_tier(replace(position, series=None), 0, 0, settings)
        return LadderChange(
            outcome=promoted.outcome,
            previous=position,
            current=promoted.current,
            points_delta=0,
            tier_changed=promoted.tier_changed,
            series_active=False,
        )

    if updated.is_lost:
        return LadderChange(
            outcome=LadderOutcome.SERIES_FAILED,
            previous=position,
            current=replace(
                position,
                # Dropped to three quarters rather than zero: failing a series
                # should cost something without erasing the climb to it.
                league_points=(settings.points_per_division * 3) // 4,
                series=None,
            ),
            points_delta=0,
            tier_changed=False,
            series_active=False,
        )

    return LadderChange(
        outcome=LadderOutcome.SERIES_ADVANCED,
        previous=position,
        current=replace(position, series=updated),
        points_delta=0,
        tier_changed=False,
        series_active=True,
    )
