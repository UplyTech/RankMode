"""Curves: the mapping from totals onto levels.

Every curve materialises a threshold table at construction:
``thresholds[level]`` is the total needed to reach ``level``, and
``thresholds[0]`` is always ``0``. Working from a table rather than from a
closed-form formula is a deliberate choice: it is the only way to guarantee
that the Python and the TypeScript edition answer identically for every input,
including the awkward ones near the top of the curve.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from typing import Any

from .constants import (
    DEFAULT_MAX_LEVEL,
    MAX_SUPPORTED_LEVEL,
    MAX_TOTAL_XP,
    MIN_TOTAL_XP,
)
from .errors import ConfigurationError, CurveError, ValidationError, XpOverflowError
from .types import LevelProgress

__all__ = [
    "Curve",
    "LinearCurve",
    "QuadraticCurve",
    "ExponentialCurve",
    "TabularCurve",
    "create_curve",
    "default_curve",
]


class Curve:
    """Base class for every curve shape.

    Instantiable in its own right -- a ``Curve`` built from a threshold list
    behaves exactly like a :class:`TabularCurve`. The subclasses differ only in
    how they generate that list.
    """

    #: Stable name, used in the serialised form and in migration reports.
    kind: str = "tabular"

    def __init__(self, thresholds: Sequence[int]) -> None:
        if not thresholds or thresholds[0] != 0:
            raise ConfigurationError(
                "A curve must start with threshold 0 for level 0",
                first=thresholds[0] if thresholds else None,
            )
        # At least level 0 and level 1. A generated curve whose ``base`` is so
        # large that even the first threshold leaves the safe range used to
        # truncate to a single entry -- a curve nobody can ever level up in,
        # reported as if it were fine. TabularCurve has always refused it; now
        # every shape does.
        if len(thresholds) < 2:
            raise ConfigurationError(
                "A curve needs at least level 0 and level 1; check that base is not too large",
                max_level=len(thresholds) - 1,
            )
        for level in range(1, len(thresholds)):
            previous = thresholds[level - 1]
            current = thresholds[level]
            if not isinstance(current, int) or isinstance(current, bool):
                raise ConfigurationError(
                    "Curve thresholds must be integers", level=level, value=current
                )
            if current > MAX_TOTAL_XP:
                raise ConfigurationError(
                    "Curve thresholds must stay in the shared safe range",
                    level=level,
                    value=current,
                )
            if current <= previous:
                raise ConfigurationError(
                    "Curve thresholds must ascend strictly",
                    level=level,
                    previous=previous,
                    current=current,
                )
        #: ``thresholds[level]`` = total needed to hold ``level``.
        self.thresholds: tuple[int, ...] = tuple(thresholds)
        #: Highest level in the table.
        self.max_level: int = len(self.thresholds) - 1

    # -- queries ----------------------------------------------------------

    def total_xp_for_level(self, level: int) -> int:
        """Total needed to reach ``level``."""
        if not isinstance(level, int) or isinstance(level, bool) or level < 0:
            raise ValidationError("Level must be a non-negative integer", level=level)
        if level > self.max_level:
            raise CurveError(
                "Level is above the top of this curve",
                level=level,
                max_level=self.max_level,
            )
        return self.thresholds[level]

    def xp_for_next_level(self, level: int) -> int:
        """XP needed to get from ``level`` to ``level + 1``."""
        if level <= 0:
            return self.total_xp_for_level(1)
        if level >= self.max_level:
            raise CurveError(
                "There is no level above the top of this curve",
                level=level,
                max_level=self.max_level,
            )
        return self.total_xp_for_level(level + 1) - self.total_xp_for_level(level)

    def level_for_total_xp(self, total_xp: int) -> int:
        """Highest level whose threshold is at or below ``total_xp``."""
        if isinstance(total_xp, bool) or not isinstance(total_xp, int):
            raise ValidationError("Total XP must be an integer", total_xp=total_xp)
        if total_xp <= 0:
            return 0
        if total_xp >= self.thresholds[self.max_level]:
            return self.max_level
        # bisect_right gives the first index above total_xp; one less is ours.
        return bisect_right(self.thresholds, total_xp) - 1

    def progress_for_total_xp(self, total_xp: int) -> LevelProgress:
        """Full progress information for a total.

        Raises :class:`~rankmode.errors.XpOverflowError` when a *reported* value
        would leave the shared safe range. The totals themselves always fit --
        the constants make sure of that -- but ``xp_to_next`` is
        ``next_threshold - total_xp``, and a deeply negative total turns that
        difference into a number Python can hold and JavaScript cannot.
        Unreachable for any total of zero or above, which is every total unless
        ``allow_negative`` is switched on.
        """
        level = self.level_for_total_xp(total_xp)
        current_threshold = self.thresholds[level]
        is_max_level = level >= self.max_level
        next_threshold = None if is_max_level else self.thresholds[level + 1]
        xp_into_level = total_xp - current_threshold
        level_span = None if next_threshold is None else next_threshold - current_threshold
        xp_to_next = None if next_threshold is None else next_threshold - total_xp

        if not _in_safe_range(xp_into_level) or not _in_safe_range(xp_to_next):
            raise XpOverflowError(
                "This total is so far below the curve that its progress "
                "cannot be reported in both editions",
                total_xp=total_xp,
                current_threshold=current_threshold,
                next_threshold=next_threshold,
            )

        if level_span is None:
            progress_permille = 1000
        elif xp_into_level <= 0:
            progress_permille = 0
        else:
            progress_permille = min(1000, (xp_into_level * 1000) // level_span)

        return LevelProgress(
            level=level,
            total_xp=total_xp,
            current_threshold=current_threshold,
            next_threshold=next_threshold,
            xp_into_level=xp_into_level,
            xp_to_next=xp_to_next,
            level_span=level_span,
            progress_permille=progress_permille,
            is_max_level=is_max_level,
        )

    # -- serialisation ----------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Serialise to a plain dict. Round-trips through :func:`create_curve`."""
        return {"kind": "tabular", "thresholds": list(self.thresholds)}

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Curve):
            return NotImplemented
        return self.thresholds == other.thresholds

    def __hash__(self) -> int:
        return hash(self.thresholds)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}(max_level={self.max_level})"


class LinearCurve(Curve):
    """Every level costs the same.

    Suitable for small servers and short-lived scopes. Not suitable for a
    community that runs for years: newcomers catch up with long-standing
    members far too easily, which devalues the whole leaderboard.
    """

    kind = "linear"

    def __init__(self, base: int = 100, max_level: int = DEFAULT_MAX_LEVEL) -> None:
        _assert_positive_int(base, "base")
        max_level = _normalise_max_level(max_level)
        thresholds = []
        for level in range(max_level + 1):
            total = base * level
            if total > MAX_TOTAL_XP:
                break
            thresholds.append(total)
        super().__init__(thresholds)
        self.base = base

    def to_dict(self) -> dict[str, Any]:
        return {"kind": "linear", "base": self.base, "maxLevel": self.max_level}


class QuadraticCurve(Curve):
    """The cost of a level grows by a constant amount per level.

    ``total(L) = base * L * (L + 1) / 2`` -- the triangular numbers. Level 1
    costs ``base``, level 2 costs ``2 * base``, and so on, so the *total* grows
    quadratically while the step from one level to the next grows evenly.

    This is the default, and the concept explains why: linear devalues
    long-standing members, exponential frustrates newcomers early. Quadratic
    keeps both in a workable relation.
    """

    kind = "quadratic"

    def __init__(self, base: int = 100, max_level: int = DEFAULT_MAX_LEVEL) -> None:
        _assert_positive_int(base, "base")
        max_level = _normalise_max_level(max_level)
        thresholds = []
        for level in range(max_level + 1):
            # level * (level + 1) is always even, so the division is exact.
            total = (base * level * (level + 1)) // 2
            if total > MAX_TOTAL_XP:
                break
            thresholds.append(total)
        super().__init__(thresholds)
        self.base = base

    def to_dict(self) -> dict[str, Any]:
        return {"kind": "quadratic", "base": self.base, "maxLevel": self.max_level}


class ExponentialCurve(Curve):
    """The cost of a level is multiplied by a constant factor each level.

    The factor is given in permille -- ``1500`` means each level costs 1.5x the
    previous one -- and every step uses integer floor division, so both editions
    produce the same table. The table stops as soon as the next total would
    leave the safe range, which is why an exponential curve usually has a much
    lower ``max_level`` than the one that was asked for.
    """

    kind = "exponential"

    def __init__(
        self,
        base: int = 100,
        growth_permille: int = 1500,
        max_level: int = DEFAULT_MAX_LEVEL,
    ) -> None:
        _assert_positive_int(base, "base")
        max_level = _normalise_max_level(max_level)
        if (
            not isinstance(growth_permille, int)
            or isinstance(growth_permille, bool)
            or growth_permille <= 1000
        ):
            raise ConfigurationError(
                "growth_permille must be an integer above 1000 (= factor 1.0)",
                growth_permille=growth_permille,
            )

        thresholds = [0]
        cost = base
        total = 0
        for _level in range(1, max_level + 1):
            if total + cost > MAX_TOTAL_XP:
                break
            total += cost
            thresholds.append(total)
            nxt = (cost * growth_permille) // 1000
            # A factor just above 1.0 can floor back to the same cost, which
            # would make the table stop ascending. Force at least one step.
            cost = nxt if nxt > cost else cost + 1
        super().__init__(thresholds)
        self.base = base
        self.growth_permille = growth_permille

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "exponential",
            "base": self.base,
            "growthPermille": self.growth_permille,
            "maxLevel": self.max_level,
        }


class TabularCurve(Curve):
    """Thresholds supplied verbatim by the operator.

    For the cases the three generated shapes do not cover -- a season pass, a
    hand-tuned table inherited from an older bot, a curve that flattens out on
    purpose.
    """

    kind = "tabular"

    def __init__(self, thresholds: Sequence[int]) -> None:
        if len(thresholds) < 2:
            raise ConfigurationError(
                "A tabular curve needs at least level 0 and level 1",
                length=len(thresholds),
            )
        if len(thresholds) - 1 > MAX_SUPPORTED_LEVEL:
            raise ConfigurationError(
                "Tabular curve exceeds the supported level range",
                max_level=len(thresholds) - 1,
                supported=MAX_SUPPORTED_LEVEL,
            )
        super().__init__(thresholds)


def create_curve(spec: Mapping[str, Any]) -> Curve:
    """Build a curve from its serialised form.

    Accepts both the Python spelling (``max_level``, ``growth_permille``) and
    the JSON spelling used by the shared test vectors (``maxLevel``,
    ``growthPermille``), so one file can drive both editions.
    """
    kind = spec.get("kind")
    if kind == "linear":
        return LinearCurve(
            base=_spec_int(spec, "base", 100),
            max_level=_spec_int(spec, "maxLevel", DEFAULT_MAX_LEVEL, "max_level"),
        )
    if kind == "quadratic":
        return QuadraticCurve(
            base=_spec_int(spec, "base", 100),
            max_level=_spec_int(spec, "maxLevel", DEFAULT_MAX_LEVEL, "max_level"),
        )
    if kind == "exponential":
        return ExponentialCurve(
            base=_spec_int(spec, "base", 100),
            growth_permille=_spec_int(spec, "growthPermille", 1500, "growth_permille"),
            max_level=_spec_int(spec, "maxLevel", DEFAULT_MAX_LEVEL, "max_level"),
        )
    if kind == "tabular":
        thresholds = spec.get("thresholds")
        if thresholds is None:
            raise ConfigurationError("A tabular curve spec needs thresholds")
        return TabularCurve(list(thresholds))
    raise ConfigurationError("Unknown curve kind", kind=kind)


def default_curve() -> Curve:
    """The curve RankMode uses when the caller does not choose one."""
    return QuadraticCurve()


def _in_safe_range(value: int | None) -> bool:
    return value is None or MIN_TOTAL_XP <= value <= MAX_TOTAL_XP


def _spec_int(
    spec: Mapping[str, Any], key: str, fallback: int, alias: str | None = None
) -> int:
    if key in spec and spec[key] is not None:
        return int(spec[key])
    if alias is not None and alias in spec and spec[alias] is not None:
        return int(spec[alias])
    return fallback


def _normalise_max_level(max_level: int) -> int:
    if not isinstance(max_level, int) or isinstance(max_level, bool) or max_level < 1:
        raise ConfigurationError(
            "max_level must be an integer of at least 1", max_level=max_level
        )
    if max_level > MAX_SUPPORTED_LEVEL:
        raise ConfigurationError(
            "max_level exceeds the supported level range",
            max_level=max_level,
            supported=MAX_SUPPORTED_LEVEL,
        )
    return max_level


def _assert_positive_int(value: int, name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ConfigurationError(f"{name} must be an integer of at least 1", **{name: value})
