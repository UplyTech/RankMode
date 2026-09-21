"""Error hierarchy for RankMode.

Every error derives from :class:`RankModeError` so callers can catch a single
base class and still tell the causes apart via ``code``.

Note the design rule from the concept: the *normal* cases are results, not
exceptions. An active cooldown, an exhausted period cap or an unknown event
type all come back as an :class:`~rankmode.types.AwardOutcome`. Errors are
reserved for programming mistakes: bad configuration, invalid input, overflow.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

__all__ = [
    "RankModeError",
    "ConfigurationError",
    "ValidationError",
    "CurveError",
    "XpOverflowError",
    "MigrationError",
    "LadderError",
    "SeasonError",
]


class RankModeError(Exception):
    """Base class for every error raised by this package."""

    #: Stable, machine-readable identifier. Never compare message texts.
    code: str = "RANKMODE_ERROR"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.message = message
        self._details: Mapping[str, Any] = MappingProxyType(dict(details))

    @property
    def details(self) -> Mapping[str, Any]:
        """Structured context for the error. Read-only."""
        return self._details

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}({self.message!r}, code={self.code!r})"


class ConfigurationError(RankModeError):
    """The engine, a curve or a rule was configured with impossible values."""

    code = "CONFIGURATION_ERROR"


class ValidationError(RankModeError):
    """A call-site argument was invalid (negative XP, non-integer, ...)."""

    code = "VALIDATION_ERROR"


class CurveError(RankModeError):
    """A curve could not answer the question (level out of range, broken table)."""

    code = "CURVE_ERROR"


class XpOverflowError(RankModeError):
    """A total would leave the safe integer range shared by both editions."""

    code = "XP_OVERFLOW"


class MigrationError(RankModeError):
    """A curve migration cannot be carried out with the requested strategy."""

    code = "MIGRATION_ERROR"


class LadderError(RankModeError):
    """A ladder position is impossible: a division in an apex tier, a tier that
    does not exist, a series that cannot be entered from where the player is."""

    code = "LADDER_ERROR"


class SeasonError(RankModeError):
    """A season cannot do what was asked: a reset into a season that has not
    started, an end before its own beginning, a transition that skips one."""

    code = "SEASON_ERROR"
