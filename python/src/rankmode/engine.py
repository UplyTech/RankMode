"""The rank engine: rules and a curve in, a result out.

Every method is pure with respect to its arguments -- the state handed in is
never modified, and a fresh state comes back in the result. Nothing is stored,
nothing is logged, no clock and no random generator is read from the
environment.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import Any

from .constants import (
    DEFAULT_PERIOD_SECONDS,
    GLOBAL_CAP_KEY,
    MAX_TOTAL_XP,
    MIN_TOTAL_XP,
    PERMILLE_ONE,
)
from .curves import Curve, default_curve
from .errors import ConfigurationError, ValidationError, XpOverflowError
from .random_source import RandomSource, SystemRandomSource

# create_member_state is re-exported, not used here: the README's examples do
# `from rankmode.engine import create_member_state`.
from .state import clone_member_state
from .state import create_member_state as create_member_state
from .types import (
    AwardOutcome,
    AwardResult,
    DecayRule,
    EventRule,
    GlobalCap,
    LevelProgress,
    MemberState,
    Multiplier,
)

__all__ = [
    "RankEngine",
    "RankConfig",
    "create_event_rule",
    "create_member_state",
    "default_rules",
    "apply_multipliers",
    "combined_permille",
]


@dataclass(frozen=True)
class RankConfig:
    """The frozen, validated configuration of a :class:`RankEngine`."""

    curve: Curve
    rules: Mapping[str, EventRule]
    default_rule: EventRule | None
    global_cap: GlobalCap | None
    decay: DecayRule | None
    allow_negative: bool
    max_total_xp: int


class RankEngine:
    """Computes awards, penalties and decay against a curve and a rule set."""

    def __init__(
        self,
        curve: Curve | None = None,
        rules: Iterable[EventRule] | None = None,
        default_rule: EventRule | None = None,
        global_cap: GlobalCap | None = None,
        decay: DecayRule | None = None,
        allow_negative: bool = False,
        max_total_xp: int = MAX_TOTAL_XP,
    ) -> None:
        self.config = _freeze_config(
            curve=curve,
            rules=rules,
            default_rule=default_rule,
            global_cap=global_cap,
            decay=decay,
            allow_negative=allow_negative,
            max_total_xp=max_total_xp,
        )

    # -- queries ----------------------------------------------------------

    @property
    def curve(self) -> Curve:
        """The configured curve."""
        return self.config.curve

    def progress(self, total_xp: int) -> LevelProgress:
        """Progress information for a total, without touching any state."""
        return self.config.curve.progress_for_total_xp(total_xp)

    def level_for(self, total_xp: int) -> int:
        """The level a total corresponds to."""
        return self.config.curve.level_for_total_xp(total_xp)

    def rule_for(self, event_type: str) -> EventRule | None:
        """The rule for an event type, or the default rule, or ``None``."""
        return self.config.rules.get(event_type, self.config.default_rule)

    def cooldown_remaining_ms(self, state: MemberState, event_type: str, now: int) -> int:
        """Milliseconds until the member may earn from ``event_type`` again."""
        rule = self.rule_for(event_type)
        if rule is None or rule.cooldown_seconds <= 0:
            return 0
        last = state.last_event_at.get(event_type)
        if last is None:
            return 0
        remaining = rule.cooldown_seconds * 1000 - (now - last)
        return remaining if remaining > 0 else 0

    def can_award(self, state: MemberState, event_type: str, now: int) -> bool:
        """True when the member could earn from ``event_type`` right now."""
        rule = self.rule_for(event_type)
        if rule is None or not rule.enabled:
            return False
        if self.cooldown_remaining_ms(state, event_type, now) > 0:
            return False
        remaining = self.period_remaining_xp(state, event_type, now)
        return remaining is None or remaining > 0

    def period_remaining_xp(self, state: MemberState, event_type: str, now: int) -> int | None:
        """XP still available to ``event_type`` in the running period.

        Takes the global cap into account, so this is the number that actually
        limits the next award -- ``None`` means nothing limits it.
        """
        rule = self.rule_for(event_type)
        limits = []
        if rule is not None and rule.period_cap_xp is not None:
            limits.append(
                _remaining_in_period(
                    state, event_type, rule.period_cap_xp, rule.period_seconds, now
                )
            )
        if self.config.global_cap is not None:
            limits.append(
                _remaining_in_period(
                    state,
                    GLOBAL_CAP_KEY,
                    self.config.global_cap.xp,
                    self.config.global_cap.period_seconds,
                    now,
                )
            )
        if not limits:
            return None
        return min(limits)

    # -- state changes ----------------------------------------------------

    def award(
        self,
        state: MemberState,
        event_type: str,
        now: int,
        multipliers: Sequence[Multiplier] = (),
        random_source: RandomSource | None = None,
        base_xp: int | None = None,
    ) -> AwardResult:
        """Award XP for an event.

        The order of checks is fixed and part of the public contract, because a
        different order produces different numbers:

        1. find the rule -- an unknown event type awards nothing
        2. rule disabled -- awards nothing
        3. cooldown -- awards nothing, and does **not** restart the cooldown
        4. roll the base value from the span
        5. apply the multipliers, in the order they were handed in
        6. trim to what is left of the period caps
        7. trim to the configured ceiling
        8. write the new total, the cooldown stamp and the period counters

        Steps 3, 6 and 7 return an outcome rather than raising: an exhausted
        cooldown is a normal state of affairs, not an error.

        ``now`` is epoch milliseconds and is handed in rather than read from the
        system clock, because a cooldown that depends on the wall clock cannot
        be tested.
        """
        _assert_timestamp(now)
        previous_total_xp = state.total_xp
        previous_level = self.level_for(previous_total_xp)
        rule = self.rule_for(event_type)

        if rule is None:
            return self._unchanged(state, AwardOutcome.UNKNOWN_EVENT, None, previous_level, 0)
        if not rule.enabled:
            return self._unchanged(state, AwardOutcome.RULE_DISABLED, rule, previous_level, 0)

        cooldown_remaining = self.cooldown_remaining_ms(state, event_type, now)
        if cooldown_remaining > 0:
            return self._unchanged(
                state, AwardOutcome.COOLDOWN, rule, previous_level, cooldown_remaining
            )

        if previous_total_xp >= self.config.max_total_xp:
            return self._unchanged(state, AwardOutcome.MAX_XP_REACHED, rule, previous_level, 0)

        # 4. Base value.
        if base_xp is not None:
            if not isinstance(base_xp, int) or isinstance(base_xp, bool) or base_xp < 0:
                raise ValidationError(
                    "base_xp override must be a non-negative integer", base_xp=base_xp
                )
            rolled = base_xp
        elif rule.min_xp == rule.max_xp:
            # No roll at all when the span is a single value -- keeps the random
            # source untouched, which makes fixed-value rules trivially testable.
            rolled = rule.min_xp
        else:
            source = random_source if random_source is not None else SystemRandomSource()
            rolled = source.random_int(rule.min_xp, rule.max_xp)

        # 5. Multipliers.
        multiplier_permille = combined_permille(multipliers)
        amount = apply_multipliers(rolled, multipliers)

        # 6. Period caps.
        period_remaining = self.period_remaining_xp(state, event_type, now)
        if period_remaining is not None:
            if period_remaining <= 0:
                return self._unchanged(
                    state,
                    AwardOutcome.PERIOD_CAP,
                    rule,
                    previous_level,
                    0,
                    period_remaining,
                )
            amount = min(amount, period_remaining)

        # 7. Ceiling.
        headroom = self.config.max_total_xp - previous_total_xp
        clamped_by_ceiling = False
        if amount > headroom:
            amount = headroom
            clamped_by_ceiling = True

        if amount <= 0:
            return self._unchanged(
                state,
                AwardOutcome.MAX_XP_REACHED if clamped_by_ceiling else AwardOutcome.NO_XP,
                rule,
                previous_level,
                0,
                period_remaining,
            )

        # 8. New state.
        nxt = clone_member_state(state)
        nxt.total_xp = previous_total_xp + amount
        # Stamped for every paying award, including rules with no cooldown.
        # Until 2.0.0 this was written only when ``cooldown_seconds > 0``, which
        # made a zero-cooldown rule -- a voice minute, say -- invisible to
        # :meth:`apply_decay`: a member active every day still decayed, because
        # decay looks here to find out when they were last active.
        # ``cooldown_remaining_ms`` returns 0 for a rule without a cooldown, so
        # nothing else changes, and :func:`prune_member_state` keeps the map
        # small.
        nxt.last_event_at[event_type] = now
        if rule.period_cap_xp is not None:
            _record_in_period(nxt, event_type, amount, rule.period_seconds, now)
        if self.config.global_cap is not None:
            _record_in_period(
                nxt,
                GLOBAL_CAP_KEY,
                amount,
                self.config.global_cap.period_seconds,
                now,
            )

        new_level = self.level_for(nxt.total_xp)
        return AwardResult(
            outcome=AwardOutcome.AWARDED,
            awarded_xp=amount,
            base_xp=rolled,
            multiplier_permille=multiplier_permille,
            previous_total_xp=previous_total_xp,
            new_total_xp=nxt.total_xp,
            previous_level=previous_level,
            new_level=new_level,
            leveled_up=new_level > previous_level,
            leveled_down=False,
            progress=self.progress(nxt.total_xp),
            rule=rule,
            cooldown_remaining_ms=rule.cooldown_seconds * 1000,
            period_remaining_xp=self.period_remaining_xp(nxt, event_type, now),
            state=nxt,
        )

    def penalize(
        self,
        state: MemberState,
        amount: int,
        now: int,
        reset_cooldown_for: Sequence[str] = (),
    ) -> AwardResult:
        """Deduct XP -- the counterpart moderation needs.

        Unless ``allow_negative`` is configured, the total stops at zero rather
        than going below it. A level loss is reported through ``leveled_down``,
        so the caller can remove a role in the same place it grants one.

        ``reset_cooldown_for`` lets the deduction consume the cooldown as well,
        so a member cannot immediately earn the XP back.
        """
        _assert_timestamp(now)
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
            raise ValidationError(
                "Penalty amount must be a non-negative integer", amount=amount
            )

        previous_total_xp = state.total_xp
        previous_level = self.level_for(previous_total_xp)
        floor = MIN_TOTAL_XP if self.config.allow_negative else 0
        removed = amount
        if previous_total_xp - removed < floor:
            removed = previous_total_xp - floor
        removed = max(removed, 0)

        nxt = clone_member_state(state)
        nxt.total_xp = previous_total_xp - removed
        for event_type in reset_cooldown_for:
            nxt.last_event_at[event_type] = now

        new_level = self.level_for(nxt.total_xp)
        return AwardResult(
            outcome=AwardOutcome.PENALISED if removed > 0 else AwardOutcome.NO_XP,
            awarded_xp=-removed,
            base_xp=amount,
            multiplier_permille=PERMILLE_ONE,
            previous_total_xp=previous_total_xp,
            new_total_xp=nxt.total_xp,
            previous_level=previous_level,
            new_level=new_level,
            leveled_up=False,
            leveled_down=new_level < previous_level,
            progress=self.progress(nxt.total_xp),
            rule=None,
            cooldown_remaining_ms=0,
            period_remaining_xp=None,
            state=nxt,
        )

    def apply_decay(self, state: MemberState, now: int) -> AwardResult:
        """Apply the configured decay.

        Decay is charged per whole elapsed period, so calling this once a day or
        once a week produces the same result -- the caller decides when to run
        it, not how much it costs.
        """
        _assert_timestamp(now)
        rule = self.config.decay
        previous_total_xp = state.total_xp
        previous_level = self.level_for(previous_total_xp)

        if rule is None:
            return self._unchanged(state, AwardOutcome.NO_DECAY_DUE, None, previous_level, 0)

        decay_start = _decay_start_at(state, rule, now)
        if now <= decay_start:
            unchanged = self._unchanged(
                state, AwardOutcome.NO_DECAY_DUE, None, previous_level, 0
            )
            marked = clone_member_state(state)
            marked.last_decay_at = (
                state.last_decay_at if state.last_decay_at is not None else now
            )
            return _replace_state(unchanged, marked)

        period_ms = rule.period_seconds * 1000
        periods = (now - decay_start) // period_ms
        if periods <= 0:
            return self._unchanged(state, AwardOutcome.NO_DECAY_DUE, None, previous_level, 0)

        removed = periods * rule.xp_per_period
        floor = max(rule.floor_xp, MIN_TOTAL_XP if self.config.allow_negative else 0)
        if previous_total_xp - removed < floor:
            removed = previous_total_xp - floor
        removed = max(removed, 0)

        nxt = clone_member_state(state)
        nxt.total_xp = previous_total_xp - removed
        nxt.last_decay_at = decay_start + periods * period_ms

        new_level = self.level_for(nxt.total_xp)
        return AwardResult(
            outcome=AwardOutcome.DECAYED if removed > 0 else AwardOutcome.NO_DECAY_DUE,
            awarded_xp=-removed,
            base_xp=periods * rule.xp_per_period,
            multiplier_permille=PERMILLE_ONE,
            previous_total_xp=previous_total_xp,
            new_total_xp=nxt.total_xp,
            previous_level=previous_level,
            new_level=new_level,
            leveled_up=False,
            leveled_down=new_level < previous_level,
            progress=self.progress(nxt.total_xp),
            rule=None,
            cooldown_remaining_ms=0,
            period_remaining_xp=None,
            state=nxt,
        )

    def estimate_time_to_level(
        self, total_xp: int, target_level: int, xp_per_hour: float
    ) -> int:
        """How many milliseconds until the member reaches ``target_level``.

        A convenience for the "when do I level up?" question every community
        asks. ``xp_per_hour`` is the caller's own estimate -- RankMode keeps no
        history it could derive one from.
        """
        # `not > 0` rather than `<= 0`, so NaN is caught: NaN <= 0 is False, and
        # until 2.0.0 that let it through to `math.ceil`, which raised a bare
        # ValueError - an exception outside the RankModeError hierarchy the
        # whole error module exists to keep callers inside.
        if not isfinite(xp_per_hour) or not xp_per_hour > 0:
            raise ValidationError(
                "xp_per_hour must be a positive, finite number", xp_per_hour=xp_per_hour
            )
        target = self.config.curve.total_xp_for_level(target_level)
        missing = target - total_xp
        if missing <= 0:
            return 0
        return _ceil_div_float(missing, xp_per_hour)

    # -- internals --------------------------------------------------------

    def _unchanged(
        self,
        state: MemberState,
        outcome: AwardOutcome,
        rule: EventRule | None,
        previous_level: int,
        cooldown_remaining_ms: int,
        period_remaining_xp: int | None = None,
    ) -> AwardResult:
        return AwardResult(
            outcome=outcome,
            awarded_xp=0,
            base_xp=0,
            multiplier_permille=PERMILLE_ONE,
            previous_total_xp=state.total_xp,
            new_total_xp=state.total_xp,
            previous_level=previous_level,
            new_level=previous_level,
            leveled_up=False,
            leveled_down=False,
            progress=self.progress(state.total_xp),
            rule=rule,
            cooldown_remaining_ms=cooldown_remaining_ms,
            period_remaining_xp=period_remaining_xp,
            state=clone_member_state(state),
        )


def create_event_rule(
    event_type: str,
    min_xp: int,
    max_xp: int | None = None,
    cooldown_seconds: int = 0,
    period_cap_xp: int | None = None,
    period_seconds: int = DEFAULT_PERIOD_SECONDS,
    enabled: bool = True,
) -> EventRule:
    """Build a validated :class:`~rankmode.types.EventRule`.

    Callers usually define their rules once, in a config file, and want the
    values checked before the bot starts rather than on the first message.
    """
    resolved_max = min_xp if max_xp is None else max_xp

    if not isinstance(event_type, str) or not event_type:
        raise ConfigurationError(
            "An event rule needs a non-empty event type", event_type=event_type
        )
    if event_type == GLOBAL_CAP_KEY:
        raise ConfigurationError(
            f"The event type {GLOBAL_CAP_KEY} is reserved for the global cap",
            event_type=event_type,
        )
    _require_non_negative_int(min_xp, "min_xp")
    if (
        not isinstance(resolved_max, int)
        or isinstance(resolved_max, bool)
        or resolved_max < min_xp
    ):
        raise ConfigurationError(
            "max_xp must be an integer of at least min_xp",
            min_xp=min_xp,
            max_xp=resolved_max,
        )
    _require_non_negative_int(cooldown_seconds, "cooldown_seconds")
    if period_cap_xp is not None:
        _require_non_negative_int(period_cap_xp, "period_cap_xp")
    if (
        not isinstance(period_seconds, int)
        or isinstance(period_seconds, bool)
        or period_seconds <= 0
    ):
        raise ConfigurationError(
            "period_seconds must be a positive integer", period_seconds=period_seconds
        )

    return EventRule(
        event_type=event_type,
        min_xp=min_xp,
        max_xp=resolved_max,
        cooldown_seconds=cooldown_seconds,
        period_cap_xp=period_cap_xp,
        period_seconds=period_seconds,
        enabled=enabled,
    )


def default_rules() -> tuple[EventRule, ...]:
    """The rule set the concept describes as the sensible starting point.

    A text message every minute, a voice minute, a reaction that is worth
    something but not much, and a forum post for the callers that are not
    Discord at all.
    """
    return (
        create_event_rule("message", 15, 25, cooldown_seconds=60, period_cap_xp=1000),
        create_event_rule("voice_minute", 5, 10, cooldown_seconds=0, period_cap_xp=1500),
        create_event_rule("reaction", 1, 2, cooldown_seconds=30, period_cap_xp=100),
        create_event_rule("post", 20, 40, cooldown_seconds=120, period_cap_xp=800),
    )


def apply_multipliers(base_xp: int, multipliers: Sequence[Multiplier]) -> int:
    """Multiply a base value by a chain of permille factors.

    Applied one after another with integer floor division, in the order given.
    The order is part of the contract: ``floor(floor(x * a) * b)`` is not always
    ``floor(floor(x * b) * a)``, and two editions that disagree about the order
    would disagree about the result.

    Raises :class:`~rankmode.errors.XpOverflowError` if the running value leaves
    the shared safe range. That is a programming mistake rather than a normal
    outcome: no rule this library will build can roll a base large enough to
    reach it, so getting there means a ``base_xp`` override or a permille factor
    that was never meant to be a factor. Python could hold the number; the
    TypeScript edition could not, and a total only one edition can hold is
    exactly what the shared range exists to prevent.
    """
    value = base_xp
    for multiplier in multipliers:
        _assert_permille(multiplier)
        value = (value * multiplier.permille) // PERMILLE_ONE
        _assert_in_safe_range(value, multiplier)
    return value


def combined_permille(multipliers: Sequence[Multiplier]) -> int:
    """The combined factor of a chain, for reporting. Not used for the maths."""
    value = PERMILLE_ONE
    for multiplier in multipliers:
        _assert_permille(multiplier)
        value = (value * multiplier.permille) // PERMILLE_ONE
        _assert_in_safe_range(value, multiplier)
    return value


def _assert_permille(multiplier: Multiplier) -> None:
    if (
        not isinstance(multiplier.permille, int)
        or isinstance(multiplier.permille, bool)
        or multiplier.permille < 0
    ):
        raise ValidationError(
            "Multiplier permille must be a non-negative integer",
            source=multiplier.source,
            permille=multiplier.permille,
        )


def _assert_in_safe_range(value: int, multiplier: Multiplier) -> None:
    if value > MAX_TOTAL_XP or value < MIN_TOTAL_XP:
        raise XpOverflowError(
            "Applying this multiplier chain leaves the shared safe integer range",
            source=multiplier.source,
            permille=multiplier.permille,
            value=value,
        )


def _remaining_in_period(
    state: MemberState, key: str, cap: int, period_seconds: int, now: int
) -> int:
    start = state.period_start_at.get(key)
    if start is None or now - start >= period_seconds * 1000:
        return cap
    used = state.period_awarded_xp.get(key, 0)
    remaining = cap - used
    return remaining if remaining > 0 else 0


def _record_in_period(
    state: MemberState, key: str, amount: int, period_seconds: int, now: int
) -> None:
    start = state.period_start_at.get(key)
    if start is None or now - start >= period_seconds * 1000:
        state.period_start_at[key] = now
        state.period_awarded_xp[key] = amount
        return
    state.period_awarded_xp[key] = state.period_awarded_xp.get(key, 0) + amount


def _decay_start_at(state: MemberState, rule: DecayRule, now: int) -> int:
    """The point in time from which decay is charged.

    The grace period is measured from the member's last paying event, *not*
    from the last decay run -- otherwise every run would push the grace period
    forward again and running decay daily would cost less than running it once
    a month. Past that point, the last decay run takes over as the anchor, so
    no period is ever charged twice.
    """
    stamps = state.last_event_at.values()
    if stamps:
        grace_end = max(stamps) + rule.grace_seconds * 1000
        if state.last_decay_at is None:
            return grace_end
        return max(state.last_decay_at, grace_end)

    # No recorded activity at all. There is no grace period to serve: the grace
    # exists to protect a member who *was* active, and nothing here says anybody
    # was. Until 2.0.0 this branch used ``last_decay_at`` as the last activity
    # and then added the grace to it, so every run pushed the window forward
    # again -- the exact failure the docstring above says this function
    # prevents. A member who has never been decayed is anchored at ``now``, so
    # the first run starts the clock rather than charging for all of history.
    return state.last_decay_at if state.last_decay_at is not None else now


def _replace_state(result: AwardResult, state: MemberState) -> AwardResult:
    """A copy of ``result`` carrying a different state object."""
    return AwardResult(
        outcome=result.outcome,
        awarded_xp=result.awarded_xp,
        base_xp=result.base_xp,
        multiplier_permille=result.multiplier_permille,
        previous_total_xp=result.previous_total_xp,
        new_total_xp=result.new_total_xp,
        previous_level=result.previous_level,
        new_level=result.new_level,
        leveled_up=result.leveled_up,
        leveled_down=result.leveled_down,
        progress=result.progress,
        rule=result.rule,
        cooldown_remaining_ms=result.cooldown_remaining_ms,
        period_remaining_xp=result.period_remaining_xp,
        state=state,
    )


def _ceil_div_float(missing: int, xp_per_hour: float) -> int:
    from math import ceil

    return int(ceil((missing / xp_per_hour) * 3600 * 1000))


def _assert_timestamp(now: Any) -> None:
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError(
            "now must be an epoch-millisecond timestamp as an integer", now=now
        )


def _require_non_negative_int(value: Any, name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ConfigurationError(f"{name} must be a non-negative integer", **{name: value})


def _freeze_config(
    curve: Curve | None,
    rules: Iterable[EventRule] | None,
    default_rule: EventRule | None,
    global_cap: GlobalCap | None,
    decay: DecayRule | None,
    allow_negative: bool,
    max_total_xp: int,
) -> RankConfig:
    resolved_curve = curve if curve is not None else default_curve()
    if not isinstance(resolved_curve, Curve):
        raise ConfigurationError("curve must be a Curve instance")

    rule_map: dict[str, EventRule] = {}
    for rule in rules or ():
        if not isinstance(rule, EventRule):
            raise ConfigurationError(
                "rules must contain EventRule instances; use create_event_rule",
                received=type(rule).__name__,
            )
        if rule.event_type in rule_map:
            raise ConfigurationError(
                "Duplicate event type in rule set", event_type=rule.event_type
            )
        rule_map[rule.event_type] = rule

    if global_cap is not None:
        _require_non_negative_int(global_cap.xp, "global_cap.xp")
        if global_cap.period_seconds <= 0:
            raise ConfigurationError(
                "global_cap.period_seconds must be positive",
                period_seconds=global_cap.period_seconds,
            )

    if decay is not None:
        _require_non_negative_int(decay.xp_per_period, "decay.xp_per_period")
        if decay.period_seconds <= 0:
            raise ConfigurationError(
                "decay.period_seconds must be positive",
                period_seconds=decay.period_seconds,
            )
        if not isinstance(decay.floor_xp, int) or isinstance(decay.floor_xp, bool):
            raise ConfigurationError(
                "decay.floor_xp must be an integer", floor_xp=decay.floor_xp
            )
        _require_non_negative_int(decay.grace_seconds, "decay.grace_seconds")

    resolved_max = min(max_total_xp, MAX_TOTAL_XP)
    if (
        not isinstance(resolved_max, int)
        or isinstance(resolved_max, bool)
        or resolved_max <= 0
    ):
        raise ConfigurationError(
            "max_total_xp must be a positive integer", max_total_xp=resolved_max
        )

    return RankConfig(
        curve=resolved_curve,
        rules=dict(rule_map),
        default_rule=default_rule,
        global_cap=global_cap,
        decay=decay,
        allow_negative=allow_negative,
        max_total_xp=resolved_max,
    )
