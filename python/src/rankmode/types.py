"""Value objects and enumerations exchanged with the caller.

Everything here is a frozen dataclass or an enum, with one deliberate
exception: :class:`MemberState` is mutable, because the caller has to load it
from a database, hand it in and store the copy that comes back. The engine
never mutates the instance it is given -- it always returns a fresh one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .constants import DEFAULT_PERIOD_SECONDS

__all__ = [
    "LevelProgress",
    "Multiplier",
    "EventRule",
    "GlobalCap",
    "DecayRule",
    "MemberState",
    "AwardOutcome",
    "AwardResult",
    "TieMode",
    "LeaderboardEntry",
    "MigrationStrategy",
    "MigrationResult",
]


@dataclass(frozen=True)
class LevelProgress:
    """Where a level sits on the curve, and how far into it a member is.

    Progress is expressed in permille (0..1000) rather than as a float so that
    the Python and TypeScript editions cannot drift apart through rounding.
    """

    #: The level the member currently holds.
    level: int
    #: The total the progress was computed from.
    total_xp: int
    #: Total required to reach ``level``.
    current_threshold: int
    #: Total required to reach ``level + 1``, or ``None`` at the top.
    next_threshold: int | None
    #: How far past ``current_threshold`` the member is.
    xp_into_level: int
    #: How much is still missing for the next level, or ``None`` at the top.
    xp_to_next: int | None
    #: Width of the current level in XP, or ``None`` at the top.
    level_span: int | None
    #: 0..1000. Always 1000 once the top of the curve is reached.
    progress_permille: int
    #: True when ``level`` is the highest level the curve knows.
    is_max_level: bool

    @property
    def progress_ratio(self) -> float:
        """Progress as a 0.0..1.0 float, for display only.

        Never feed this back into a calculation: the permille value is the
        authoritative one, and it is what the shared test vectors pin down.
        """
        return self.progress_permille / 1000


@dataclass(frozen=True)
class Multiplier:
    """A factor applied to the base XP of a single award.

    ``permille`` is an integer: 1000 = x1.0, 1500 = x1.5, 2000 = double XP.
    Where the factor comes from -- a role, a channel, a promotion weekend --
    is the caller's business; RankMode only needs the number and a name.
    """

    source: str
    permille: int


@dataclass(frozen=True)
class EventRule:
    """What an event is worth, plus its abuse limits.

    Build these through :func:`rankmode.engine.create_event_rule` so the values
    are checked when the bot starts rather than on the first message.
    """

    #: Identifier the caller passes to :meth:`~rankmode.engine.RankEngine.award`.
    event_type: str
    #: Lower bound of the random span, inclusive.
    min_xp: int
    #: Upper bound, inclusive. Equal to ``min_xp`` means a fixed award.
    max_xp: int
    #: Minimum distance between two paying events of this type, per member.
    cooldown_seconds: int = 0
    #: Ceiling per period, or ``None`` for no ceiling.
    period_cap_xp: int | None = None
    #: Length of the capping period.
    period_seconds: int = DEFAULT_PERIOD_SECONDS
    #: A disabled rule awards nothing and reports ``AwardOutcome.RULE_DISABLED``.
    enabled: bool = True


@dataclass(frozen=True)
class GlobalCap:
    """A ceiling that applies across all event types together."""

    xp: int
    period_seconds: int = DEFAULT_PERIOD_SECONDS


@dataclass(frozen=True)
class DecayRule:
    """Optional XP decay, so leaderboards stay current instead of historical."""

    #: XP removed per elapsed period.
    xp_per_period: int
    #: Length of one decay period in seconds.
    period_seconds: int = DEFAULT_PERIOD_SECONDS
    #: Decay never pushes a total below this.
    floor_xp: int = 0
    #: No decay until this much time has passed since the last paying event.
    grace_seconds: int = 0


@dataclass
class MemberState:
    """Everything RankMode needs to know about a single member.

    The caller owns this object: read it from your database, hand it in, store
    the copy that comes back. RankMode never writes it anywhere itself.
    """

    #: Current total.
    total_xp: int = 0
    #: event type -> epoch milliseconds of the last paying event.
    last_event_at: dict[str, int] = field(default_factory=dict)
    #: event type (or ``*`` for the global cap) -> start of the running period.
    period_start_at: dict[str, int] = field(default_factory=dict)
    #: event type (or ``*``) -> XP already awarded inside the running period.
    period_awarded_xp: dict[str, int] = field(default_factory=dict)
    #: Epoch milliseconds of the last decay run, or ``None`` if it never ran.
    last_decay_at: int | None = None


class AwardOutcome(str, Enum):
    """Why an award turned out the way it did.

    Derives from :class:`str` so the value can be stored, logged by the caller
    and compared against the shared test vectors without conversion.
    """

    #: XP was granted.
    AWARDED = "AWARDED"
    #: The member's cooldown for this event type has not expired yet.
    COOLDOWN = "COOLDOWN"
    #: The period ceiling for this event type or the global one is exhausted.
    PERIOD_CAP = "PERIOD_CAP"
    #: The rule exists but is switched off.
    RULE_DISABLED = "RULE_DISABLED"
    #: No rule matched the event type and no default rule is configured.
    UNKNOWN_EVENT = "UNKNOWN_EVENT"
    #: The total is already at the configured ceiling.
    MAX_XP_REACHED = "MAX_XP_REACHED"
    #: The rule matched but the computed amount was zero.
    NO_XP = "NO_XP"
    #: XP was deducted by :meth:`~rankmode.engine.RankEngine.penalize`.
    PENALISED = "PENALISED"
    #: XP was removed by :meth:`~rankmode.engine.RankEngine.apply_decay`.
    DECAYED = "DECAYED"
    #: Decay ran but nothing was due.
    NO_DECAY_DUE = "NO_DECAY_DUE"


@dataclass(frozen=True)
class AwardResult:
    """The result of every state-changing engine call."""

    outcome: AwardOutcome
    #: Signed. Positive for awards, negative for penalties and decay.
    awarded_xp: int
    #: What the rule rolled before multipliers and caps.
    base_xp: int
    #: Product of all applied multipliers, in permille.
    multiplier_permille: int
    previous_total_xp: int
    new_total_xp: int
    previous_level: int
    new_level: int
    leveled_up: bool
    leveled_down: bool
    #: Progress after the change -- the numbers a level card wants.
    progress: LevelProgress
    #: The rule that was applied, or ``None``.
    rule: EventRule | None
    #: Milliseconds until the cooldown expires. ``0`` when it is not active.
    cooldown_remaining_ms: int
    #: XP still available in the running period, or ``None`` when uncapped.
    period_remaining_xp: int | None
    #: The new state. Persist this; the input state is left untouched.
    state: MemberState

    @property
    def changed(self) -> bool:
        """True when the total moved. The usual "do I need to write?" check."""
        return self.awarded_xp != 0


class TieMode(str, Enum):
    """How to number members that hold the same total."""

    #: 1, 2, 2, 4 -- the usual sports ranking.
    COMPETITION = "COMPETITION"
    #: 1, 2, 2, 3 -- no gaps after a tie.
    DENSE = "DENSE"
    #: 1, 2, 3, 4 -- ties broken by input order.
    ORDINAL = "ORDINAL"


@dataclass(frozen=True)
class LeaderboardEntry:
    """One row of a leaderboard."""

    member_id: str
    total_xp: int
    level: int
    #: Rank under the selected :class:`TieMode`.
    rank: int
    #: Competition rank (1, 2, 2, 4), always present for reference.
    competition_rank: int
    #: Dense rank (1, 2, 2, 3), always present for reference.
    dense_rank: int
    #: Zero-based position in the sorted list, before ``offset`` and ``limit``.
    position: int
    progress: LevelProgress


class MigrationStrategy(str, Enum):
    """How a curve change should treat the totals of existing members."""

    #: Keep the level, drop the progress inside it.
    PRESERVE_LEVEL = "PRESERVE_LEVEL"
    #: Keep the level *and* the progress inside it. The recommended default.
    PRESERVE_PROGRESS = "PRESERVE_PROGRESS"
    #: Keep the raw total. Levels move -- only sensible for a fresh scope.
    PRESERVE_XP = "PRESERVE_XP"


@dataclass(frozen=True)
class MigrationResult:
    """What a migration did to a single total."""

    strategy: MigrationStrategy
    previous_total_xp: int
    new_total_xp: int
    previous_level: int
    new_level: int
    level_delta: int
    previous_progress_permille: int
    new_progress_permille: int
    #: True when the new curve is shorter than the member's old level, so they
    #: were placed at its top instead. Called ``clamped_to_keep_level`` until
    #: 2.0.0, and documented as the opposite of what it was ever set for.
    clamped_to_curve_top: bool
