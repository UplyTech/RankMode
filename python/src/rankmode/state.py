"""Helpers around :class:`~rankmode.types.MemberState`.

The state serialises to a plain dict on purpose: the caller has to store it in
its own database, and a plain dict survives ``json.dumps``, a JSONB column and
a document store without a mapper.

The serialised field names are the JSON ones (``totalXp``, ``lastEventAt``, ...)
so a row written by the Python edition can be read by the TypeScript edition
and the other way round. A bot that is being ported keeps its data.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .constants import MAX_TOTAL_XP, MIN_TOTAL_XP
from .errors import ValidationError
from .types import MemberState

__all__ = [
    "create_member_state",
    "clone_member_state",
    "serialize_member_state",
    "deserialize_member_state",
    "prune_member_state",
]


def create_member_state(total_xp: int = 0) -> MemberState:
    """A fresh state for a member who has not earned anything yet."""
    if not isinstance(total_xp, int) or isinstance(total_xp, bool):
        raise ValidationError("total_xp must be an integer", total_xp=total_xp)
    if total_xp > MAX_TOTAL_XP or total_xp < MIN_TOTAL_XP:
        raise ValidationError(
            "total_xp must stay inside the shared safe range", total_xp=total_xp
        )
    return MemberState(total_xp=total_xp)


def clone_member_state(state: MemberState) -> MemberState:
    """Deep copy. The engine never mutates the state it is handed."""
    return MemberState(
        total_xp=state.total_xp,
        last_event_at=dict(state.last_event_at),
        period_start_at=dict(state.period_start_at),
        period_awarded_xp=dict(state.period_awarded_xp),
        last_decay_at=state.last_decay_at,
    )


def serialize_member_state(state: MemberState) -> dict[str, Any]:
    """Plain-dict form, ready for :func:`json.dumps`."""
    return {
        "totalXp": state.total_xp,
        "lastEventAt": dict(state.last_event_at),
        "periodStartAt": dict(state.period_start_at),
        "periodAwardedXp": dict(state.period_awarded_xp),
        "lastDecayAt": state.last_decay_at,
    }


def deserialize_member_state(raw: Mapping[str, Any]) -> MemberState:
    """Rebuild a state from stored data.

    Missing fields are filled with their empty defaults, so a row written by an
    older version of the calling bot still loads. Both the JSON field names and
    the Python ones are accepted.
    """
    if not isinstance(raw, Mapping):
        raise ValidationError("Member state must be a mapping", received=type(raw).__name__)

    total_xp = _pick(raw, "totalXp", "total_xp", default=0)
    if not isinstance(total_xp, int) or isinstance(total_xp, bool):
        raise ValidationError("totalXp must be an integer", total_xp=total_xp)
    if total_xp > MAX_TOTAL_XP or total_xp < MIN_TOTAL_XP:
        raise ValidationError(
            "totalXp must stay inside the shared safe range", total_xp=total_xp
        )

    last_decay_at = _pick(raw, "lastDecayAt", "last_decay_at", default=None)
    if last_decay_at is not None and (
        not isinstance(last_decay_at, int) or isinstance(last_decay_at, bool)
    ):
        raise ValidationError(
            "lastDecayAt must be a timestamp or None", last_decay_at=last_decay_at
        )

    return MemberState(
        total_xp=total_xp,
        last_event_at=_read_int_map(
            _pick(raw, "lastEventAt", "last_event_at", default=None), "lastEventAt"
        ),
        period_start_at=_read_int_map(
            _pick(raw, "periodStartAt", "period_start_at", default=None),
            "periodStartAt",
        ),
        period_awarded_xp=_read_int_map(
            _pick(raw, "periodAwardedXp", "period_awarded_xp", default=None),
            "periodAwardedXp",
        ),
        last_decay_at=last_decay_at,
    )


def prune_member_state(state: MemberState, now: int, keep_cooldown_ms: int = 0) -> MemberState:
    """Drop entries the engine can no longer need.

    A long-lived member accumulates one ``last_event_at`` entry per event type
    they ever triggered. This removes cooldown stamps that expired longer than
    ``keep_cooldown_ms`` ago, so the stored row stays small.
    """
    pruned = clone_member_state(state)
    pruned.last_event_at = {
        key: at for key, at in pruned.last_event_at.items() if now - at <= keep_cooldown_ms
    }
    return pruned


def _pick(raw: Mapping[str, Any], json_key: str, python_key: str, default: Any) -> Any:
    if json_key in raw and raw[json_key] is not None:
        return raw[json_key]
    if python_key in raw and raw[python_key] is not None:
        return raw[python_key]
    return default


def _read_int_map(value: Mapping[str, Any] | None, field: str) -> dict[str, int]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValidationError(f"{field} must be a mapping", field=field)
    result: dict[str, int] = {}
    for key, entry in value.items():
        if not isinstance(entry, int) or isinstance(entry, bool):
            raise ValidationError(
                f"{field} contains a non-integer value", key=key, entry=entry
            )
        result[str(key)] = entry
    return result
