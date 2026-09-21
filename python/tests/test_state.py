"""Member state: creation, cloning, persistence round-trips and pruning."""

from __future__ import annotations

import json

import pytest

from rankmode import (
    MAX_TOTAL_XP,
    AwardOutcome,
    QuadraticCurve,
    RankEngine,
    ValidationError,
    clone_member_state,
    create_event_rule,
    create_member_state,
    deserialize_member_state,
    prune_member_state,
    serialize_member_state,
)

T0 = 1_700_000_000_000


class TestCreateMemberState:
    def test_starts_empty(self) -> None:
        state = create_member_state()
        assert state.total_xp == 0
        assert state.last_event_at == {}
        assert state.last_decay_at is None

    def test_can_start_from_an_existing_total(self) -> None:
        assert create_member_state(1234).total_xp == 1234

    @pytest.mark.parametrize("total", [1.5, "100", MAX_TOTAL_XP + 1, -MAX_TOTAL_XP - 1])
    def test_refuses_a_total_outside_the_safe_range(self, total: object) -> None:
        with pytest.raises(ValidationError):
            create_member_state(total)  # type: ignore[arg-type]

    def test_two_fresh_states_do_not_share_their_maps(self) -> None:
        first = create_member_state()
        second = create_member_state()
        first.last_event_at["message"] = T0
        assert second.last_event_at == {}


class TestCloneMemberState:
    def test_copies_the_maps_rather_than_sharing_them(self) -> None:
        state = create_member_state(10)
        state.last_event_at["message"] = T0
        copy = clone_member_state(state)
        copy.last_event_at["message"] = 0
        assert state.last_event_at["message"] == T0


class TestSerialisation:
    def test_round_trips_through_json(self) -> None:
        engine = RankEngine(
            curve=QuadraticCurve(base=100, max_level=10),
            rules=[create_event_rule("message", 10, cooldown_seconds=60, period_cap_xp=100)],
        )
        awarded = engine.award(create_member_state(), "message", now=T0)

        restored = deserialize_member_state(
            json.loads(json.dumps(serialize_member_state(awarded.state)))
        )
        assert restored == awarded.state

        blocked = engine.award(restored, "message", now=T0 + 1000)
        assert blocked.outcome is AwardOutcome.COOLDOWN

    def test_uses_the_json_field_names_shared_with_the_typescript_edition(self) -> None:
        payload = serialize_member_state(create_member_state(5))
        assert set(payload) == {
            "totalXp",
            "lastEventAt",
            "periodStartAt",
            "periodAwardedXp",
            "lastDecayAt",
        }

    def test_reads_the_python_field_names_too(self) -> None:
        restored = deserialize_member_state(
            {"total_xp": 42, "last_event_at": {"message": T0}, "last_decay_at": T0}
        )
        assert restored.total_xp == 42
        assert restored.last_event_at == {"message": T0}
        assert restored.last_decay_at == T0

    def test_fills_in_fields_an_older_caller_did_not_store(self) -> None:
        restored = deserialize_member_state({"totalXp": 500})
        assert restored.total_xp == 500
        assert restored.last_event_at == {}
        assert restored.period_start_at == {}
        assert restored.period_awarded_xp == {}
        assert restored.last_decay_at is None

    def test_defaults_an_empty_row_to_a_fresh_member(self) -> None:
        assert deserialize_member_state({}).total_xp == 0

    @pytest.mark.parametrize(
        "raw",
        [
            "nope",
            {"totalXp": "500"},
            {"totalXp": 1.5},
            {"totalXp": MAX_TOTAL_XP + 1},
            {"lastEventAt": 5},
            {"lastEventAt": {"a": "x"}},
            {"lastDecayAt": "now"},
        ],
    )
    def test_rejects_data_it_cannot_trust(self, raw: object) -> None:
        with pytest.raises(ValidationError):
            deserialize_member_state(raw)  # type: ignore[arg-type]

    def test_accepts_an_explicit_null_last_decay_at(self) -> None:
        assert (
            deserialize_member_state({"totalXp": 1, "lastDecayAt": None}).last_decay_at is None
        )


class TestPruneMemberState:
    def test_drops_stamps_that_can_no_longer_block_anything(self) -> None:
        state = create_member_state(100)
        state.last_event_at["message"] = T0 - 10 * 60_000
        state.last_event_at["reaction"] = T0 - 1_000

        pruned = prune_member_state(state, now=T0, keep_cooldown_ms=60_000)
        assert "message" not in pruned.last_event_at
        assert pruned.last_event_at["reaction"] == T0 - 1_000
        assert pruned.total_xp == 100

    def test_leaves_the_original_untouched(self) -> None:
        state = create_member_state(100)
        state.last_event_at["message"] = T0 - 10 * 60_000
        prune_member_state(state, now=T0)
        assert "message" in state.last_event_at
