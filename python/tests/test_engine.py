"""Awards, cooldowns, caps, penalties and decay."""

from __future__ import annotations

from typing import Any

import pytest

from rankmode import (
    GLOBAL_CAP_KEY,
    MAX_TOTAL_XP,
    AwardOutcome,
    ConfigurationError,
    DecayRule,
    FixedRandomSource,
    GlobalCap,
    LinearCurve,
    Multiplier,
    QuadraticCurve,
    RankEngine,
    TabularCurve,
    ValidationError,
    apply_multipliers,
    combined_permille,
    create_event_rule,
    create_member_state,
    default_rules,
)

T0 = 1_700_000_000_000
MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR


def engine(**overrides: Any) -> RankEngine:
    defaults: dict[str, Any] = {
        "curve": QuadraticCurve(base=100, max_level=50),
        "rules": [
            create_event_rule("message", 15, 25, cooldown_seconds=60, period_cap_xp=1000)
        ],
    }
    defaults.update(overrides)
    return RankEngine(**defaults)


def fixed(value: int) -> FixedRandomSource:
    """Always rolls the same value, so awards are predictable."""
    return FixedRandomSource([value])


class TestAward:
    def test_grants_xp_and_reports_the_new_level(self) -> None:
        result = engine().award(
            create_member_state(), "message", now=T0, random_source=fixed(20)
        )
        assert result.outcome is AwardOutcome.AWARDED
        assert result.awarded_xp == 20
        assert result.base_xp == 20
        assert result.new_total_xp == 20
        assert result.previous_level == 0
        assert result.new_level == 0
        assert result.leveled_up is False
        assert result.changed is True

    def test_never_mutates_the_state_it_was_given(self) -> None:
        state = create_member_state(500)
        result = engine().award(state, "message", now=T0, random_source=fixed(20))
        assert state.total_xp == 500
        assert state.last_event_at == {}
        assert result.state.total_xp == 520
        assert result.state.last_event_at["message"] == T0

    def test_reports_a_level_up_exactly_once(self) -> None:
        rank = engine()
        first = rank.award(create_member_state(90), "message", now=T0, random_source=fixed(20))
        assert first.leveled_up is True
        assert first.new_level == 1

        second = rank.award(
            first.state, "message", now=T0 + 2 * MINUTE, random_source=fixed(20)
        )
        assert second.leveled_up is False
        assert second.new_level == 1

    def test_blocks_a_second_award_inside_the_cooldown(self) -> None:
        rank = engine()
        first = rank.award(create_member_state(), "message", now=T0, random_source=fixed(20))
        second = rank.award(first.state, "message", now=T0 + 30_000, random_source=fixed(20))
        assert second.outcome is AwardOutcome.COOLDOWN
        assert second.awarded_xp == 0
        assert second.new_total_xp == 20
        assert second.cooldown_remaining_ms == 30_000
        assert second.changed is False

    def test_does_not_restart_the_cooldown_when_it_blocks(self) -> None:
        rank = engine()
        first = rank.award(create_member_state(), "message", now=T0, random_source=fixed(20))
        blocked = rank.award(first.state, "message", now=T0 + 30_000, random_source=fixed(20))
        # Without the "no restart" rule, spamming would keep the cooldown alive.
        third = rank.award(blocked.state, "message", now=T0 + 61_000, random_source=fixed(20))
        assert third.outcome is AwardOutcome.AWARDED

    def test_cooldown_expires_exactly_on_the_boundary(self) -> None:
        rank = engine()
        first = rank.award(create_member_state(), "message", now=T0, random_source=fixed(20))
        on_boundary = rank.award(
            first.state, "message", now=T0 + 60_000, random_source=fixed(20)
        )
        assert on_boundary.outcome is AwardOutcome.AWARDED

    def test_unknown_event_is_a_result_not_an_exception(self) -> None:
        result = engine().award(create_member_state(), "sacrifice", now=T0)
        assert result.outcome is AwardOutcome.UNKNOWN_EVENT
        assert result.rule is None
        assert result.awarded_xp == 0

    def test_falls_back_to_the_default_rule(self) -> None:
        rank = engine(default_rule=create_event_rule("any", 5))
        result = rank.award(create_member_state(), "something-else", now=T0)
        assert result.outcome is AwardOutcome.AWARDED
        assert result.awarded_xp == 5

    def test_reports_a_disabled_rule(self) -> None:
        rank = engine(rules=[create_event_rule("message", 10, enabled=False)])
        assert (
            rank.award(create_member_state(), "message", now=T0).outcome
            is AwardOutcome.RULE_DISABLED
        )

    def test_skips_the_random_source_for_a_single_value_span(self) -> None:
        rank = engine(rules=[create_event_rule("message", 7, 7)])
        source = FixedRandomSource([99])
        result = rank.award(create_member_state(), "message", now=T0, random_source=source)
        assert result.awarded_xp == 7
        assert source.consumed == 0

    def test_accepts_a_base_value_instead_of_rolling_one(self) -> None:
        result = engine().award(create_member_state(), "message", now=T0, base_xp=42)
        assert result.base_xp == 42
        assert result.awarded_xp == 42

    def test_refuses_a_negative_base_override(self) -> None:
        with pytest.raises(ValidationError):
            engine().award(create_member_state(), "message", now=T0, base_xp=-1)

    @pytest.mark.parametrize("now", [1.5, "now", None])
    def test_refuses_a_non_integer_timestamp(self, now: object) -> None:
        with pytest.raises(ValidationError):
            engine().award(create_member_state(), "message", now=now)  # type: ignore[arg-type]

    def test_stays_inside_the_random_span(self) -> None:
        rank = engine()
        source = FixedRandomSource(list(range(15, 26)))
        state = create_member_state()
        for index in range(11):
            result = rank.award(
                state, "message", now=T0 + index * 2 * MINUTE, random_source=source
            )
            assert 15 <= result.awarded_xp <= 25
            state = result.state

    def test_uses_the_system_source_when_none_is_given(self) -> None:
        rank = engine()
        result = rank.award(create_member_state(), "message", now=T0)
        assert 15 <= result.awarded_xp <= 25


class TestMultipliers:
    def test_applies_a_factor_to_the_base_value(self) -> None:
        result = engine().award(
            create_member_state(),
            "message",
            now=T0,
            random_source=fixed(20),
            multipliers=[Multiplier("double-xp-weekend", 2000)],
        )
        assert result.awarded_xp == 40
        assert result.multiplier_permille == 2000

    def test_chains_factors_in_the_order_given(self) -> None:
        chain = [Multiplier("a", 1500), Multiplier("b", 1500)]
        # floor(10*1.5)=15, floor(15*1.5)=22
        assert apply_multipliers(10, chain) == 22
        assert combined_permille(chain) == 2250

    def test_floors_at_every_step_so_order_can_matter(self) -> None:
        a = apply_multipliers(7, [Multiplier("a", 1500), Multiplier("b", 1100)])
        b = apply_multipliers(7, [Multiplier("b", 1100), Multiplier("a", 1500)])
        assert a == 11  # floor(10.5)=10 -> floor(11)=11
        assert b == 10  # floor(7.7)=7 -> floor(10.5)=10

    def test_supports_a_reducing_factor(self) -> None:
        result = engine().award(
            create_member_state(),
            "message",
            now=T0,
            random_source=fixed(20),
            multipliers=[Multiplier("muted-channel", 500)],
        )
        assert result.awarded_xp == 10

    def test_reports_no_xp_when_a_factor_eliminates_the_award(self) -> None:
        result = engine().award(
            create_member_state(),
            "message",
            now=T0,
            random_source=fixed(20),
            multipliers=[Multiplier("no-xp-channel", 0)],
        )
        assert result.outcome is AwardOutcome.NO_XP
        assert result.new_total_xp == 0
        assert "message" not in result.state.last_event_at

    @pytest.mark.parametrize("permille", [-1, 1.5, True])
    def test_refuses_an_impossible_factor(self, permille: object) -> None:
        with pytest.raises(ValidationError):
            apply_multipliers(10, [Multiplier("x", permille)])  # type: ignore[arg-type]
        with pytest.raises(ValidationError):
            combined_permille([Multiplier("x", permille)])  # type: ignore[arg-type]


class TestPeriodCaps:
    def test_trims_the_last_award_of_the_period(self) -> None:
        rank = engine(
            rules=[create_event_rule("message", 30, 30, cooldown_seconds=0, period_cap_xp=100)]
        )
        state = create_member_state()
        for index in range(3):
            state = rank.award(state, "message", now=T0 + index * 1000).state
        assert state.total_xp == 90

        trimmed = rank.award(state, "message", now=T0 + 4000)
        assert trimmed.outcome is AwardOutcome.AWARDED
        assert trimmed.awarded_xp == 10
        assert trimmed.new_total_xp == 100

        blocked = rank.award(trimmed.state, "message", now=T0 + 5000)
        assert blocked.outcome is AwardOutcome.PERIOD_CAP
        assert blocked.period_remaining_xp == 0

    def test_starts_a_fresh_period_once_the_old_one_is_over(self) -> None:
        rank = engine(
            rules=[
                create_event_rule(
                    "message",
                    100,
                    100,
                    cooldown_seconds=0,
                    period_cap_xp=100,
                    period_seconds=3600,
                )
            ]
        )
        first = rank.award(create_member_state(), "message", now=T0)
        blocked = rank.award(first.state, "message", now=T0 + 30 * MINUTE)
        assert blocked.outcome is AwardOutcome.PERIOD_CAP

        next_period = rank.award(blocked.state, "message", now=T0 + HOUR)
        assert next_period.outcome is AwardOutcome.AWARDED
        assert next_period.awarded_xp == 100

    def test_applies_the_global_cap_across_event_types(self) -> None:
        rank = engine(
            rules=[
                create_event_rule("message", 40, 40, cooldown_seconds=0),
                create_event_rule("reaction", 40, 40, cooldown_seconds=0),
            ],
            global_cap=GlobalCap(xp=100, period_seconds=86400),
        )
        state = create_member_state()
        state = rank.award(state, "message", now=T0).state
        state = rank.award(state, "reaction", now=T0 + 1000).state
        assert state.total_xp == 80

        trimmed = rank.award(state, "message", now=T0 + 2000)
        assert trimmed.awarded_xp == 20
        assert trimmed.state.period_awarded_xp[GLOBAL_CAP_KEY] == 100

        blocked = rank.award(trimmed.state, "reaction", now=T0 + 3000)
        assert blocked.outcome is AwardOutcome.PERIOD_CAP

    def test_uses_the_tighter_of_the_two_caps(self) -> None:
        rank = engine(
            rules=[
                create_event_rule("message", 10, 10, cooldown_seconds=0, period_cap_xp=500)
            ],
            global_cap=GlobalCap(xp=30, period_seconds=86400),
        )
        assert rank.period_remaining_xp(create_member_state(), "message", T0) == 30

    def test_reports_no_limit_when_nothing_caps_the_event(self) -> None:
        rank = engine(rules=[create_event_rule("message", 10)])
        assert rank.period_remaining_xp(create_member_state(), "message", T0) is None


class TestCeiling:
    def test_stops_at_the_configured_maximum(self) -> None:
        rank = engine(
            curve=LinearCurve(base=100, max_level=10),
            rules=[create_event_rule("message", 50, 50)],
            max_total_xp=100,
        )
        result = rank.award(create_member_state(80), "message", now=T0)
        assert result.awarded_xp == 20
        assert result.new_total_xp == 100

        at_ceiling = rank.award(result.state, "message", now=T0 + DAY)
        assert at_ceiling.outcome is AwardOutcome.MAX_XP_REACHED

    def test_clamps_the_ceiling_to_the_shared_safe_range(self) -> None:
        assert engine(max_total_xp=MAX_TOTAL_XP * 2).config.max_total_xp == MAX_TOTAL_XP


class TestPenalize:
    def test_removes_xp_and_reports_the_level_loss(self) -> None:
        result = engine().penalize(create_member_state(350), 100, now=T0)
        assert result.outcome is AwardOutcome.PENALISED
        assert result.awarded_xp == -100
        assert result.new_total_xp == 250
        assert result.previous_level == 2
        assert result.new_level == 1
        assert result.leveled_down is True

    def test_stops_at_zero_by_default(self) -> None:
        result = engine().penalize(create_member_state(30), 100, now=T0)
        assert result.new_total_xp == 0
        assert result.awarded_xp == -30

    def test_goes_below_zero_when_allowed(self) -> None:
        result = engine(allow_negative=True).penalize(create_member_state(30), 100, now=T0)
        assert result.new_total_xp == -70

    def test_can_consume_the_cooldown(self) -> None:
        rank = engine()
        result = rank.penalize(
            create_member_state(500), 100, now=T0, reset_cooldown_for=["message"]
        )
        assert result.state.last_event_at["message"] == T0
        blocked = rank.award(result.state, "message", now=T0 + 1000)
        assert blocked.outcome is AwardOutcome.COOLDOWN

    def test_reports_no_xp_when_there_is_nothing_to_take(self) -> None:
        result = engine().penalize(create_member_state(0), 100, now=T0)
        assert result.outcome is AwardOutcome.NO_XP

    @pytest.mark.parametrize("amount", [-5, 1.5, "10"])
    def test_refuses_an_impossible_penalty(self, amount: object) -> None:
        with pytest.raises(ValidationError):
            engine().penalize(create_member_state(100), amount, now=T0)  # type: ignore[arg-type]


class TestDecay:
    @staticmethod
    def decay_engine() -> RankEngine:
        return engine(
            decay=DecayRule(
                xp_per_period=10,
                period_seconds=86400,
                floor_xp=0,
                grace_seconds=7 * 86400,
            )
        )

    def test_does_nothing_inside_the_grace_period(self) -> None:
        state = create_member_state(1000)
        state.last_event_at["message"] = T0
        result = self.decay_engine().apply_decay(state, now=T0 + 3 * DAY)
        assert result.outcome is AwardOutcome.NO_DECAY_DUE
        assert result.new_total_xp == 1000

    def test_charges_whole_periods_after_the_grace(self) -> None:
        state = create_member_state(1000)
        state.last_event_at["message"] = T0
        result = self.decay_engine().apply_decay(state, now=T0 + 10 * DAY)
        assert result.outcome is AwardOutcome.DECAYED
        assert result.awarded_xp == -30  # 10 days - 7 grace = 3 periods
        assert result.new_total_xp == 970

    def test_daily_and_one_off_runs_agree(self) -> None:
        rank = self.decay_engine()
        base = create_member_state(1000)
        base.last_event_at["message"] = T0

        at_once = rank.apply_decay(base, now=T0 + 12 * DAY).new_total_xp

        stepwise = base
        for day in range(8, 13):
            stepwise = rank.apply_decay(stepwise, now=T0 + day * DAY).state
        assert stepwise.total_xp == at_once

    def test_never_decays_below_the_floor(self) -> None:
        rank = engine(
            decay=DecayRule(
                xp_per_period=100, period_seconds=86400, floor_xp=500, grace_seconds=0
            )
        )
        state = create_member_state(550)
        state.last_decay_at = T0
        assert rank.apply_decay(state, now=T0 + 30 * DAY).new_total_xp == 500

    def test_reports_the_level_loss_caused_by_decay(self) -> None:
        rank = engine(
            decay=DecayRule(
                xp_per_period=100, period_seconds=86400, floor_xp=0, grace_seconds=0
            )
        )
        state = create_member_state(350)
        state.last_decay_at = T0
        result = rank.apply_decay(state, now=T0 + 2 * DAY)
        assert result.previous_level == 2
        assert result.new_level == 1
        assert result.leveled_down is True

    def test_is_a_no_op_without_a_decay_rule(self) -> None:
        result = engine().apply_decay(create_member_state(1000), now=T0 + 999 * DAY)
        assert result.outcome is AwardOutcome.NO_DECAY_DUE
        assert result.new_total_xp == 1000

    def test_anchors_on_now_for_a_member_who_never_earned(self) -> None:
        result = self.decay_engine().apply_decay(create_member_state(1000), now=T0)
        assert result.outcome is AwardOutcome.NO_DECAY_DUE
        assert result.state.last_decay_at == T0

    def test_reports_no_decay_when_the_floor_is_already_reached(self) -> None:
        rank = engine(
            decay=DecayRule(
                xp_per_period=100, period_seconds=86400, floor_xp=500, grace_seconds=0
            )
        )
        state = create_member_state(500)
        state.last_decay_at = T0
        result = rank.apply_decay(state, now=T0 + 5 * DAY)
        assert result.outcome is AwardOutcome.NO_DECAY_DUE
        assert result.new_total_xp == 500


class TestQueries:
    def test_answers_whether_an_award_is_possible(self) -> None:
        rank = engine()
        state = create_member_state()
        assert rank.can_award(state, "message", T0) is True
        assert rank.can_award(state, "unknown", T0) is False

        awarded = rank.award(state, "message", now=T0, random_source=fixed(20))
        assert rank.can_award(awarded.state, "message", T0 + 1000) is False
        assert rank.can_award(awarded.state, "message", T0 + 61_000) is True

    def test_can_award_is_false_for_a_disabled_rule(self) -> None:
        rank = engine(rules=[create_event_rule("message", 10, enabled=False)])
        assert rank.can_award(create_member_state(), "message", T0) is False

    def test_can_award_is_false_once_the_cap_is_used_up(self) -> None:
        rank = engine(
            rules=[create_event_rule("message", 10, 10, cooldown_seconds=0, period_cap_xp=10)]
        )
        used = rank.award(create_member_state(), "message", now=T0)
        assert rank.can_award(used.state, "message", T0 + 1000) is False

    def test_exposes_the_rule_for_an_event_type(self) -> None:
        rank = engine()
        assert rank.rule_for("message").min_xp == 15  # type: ignore[union-attr]
        assert rank.rule_for("nope") is None

    def test_reports_progress_without_a_state(self) -> None:
        rank = engine()
        assert rank.level_for(300) == 2
        assert rank.progress(300).level == 2
        assert isinstance(rank.curve, QuadraticCurve)

    def test_estimates_the_time_to_a_target_level(self) -> None:
        rank = engine()
        # level 3 sits at 600; 100 XP missing at 100 XP/h = one hour
        assert rank.estimate_time_to_level(500, 3, 100) == HOUR
        assert rank.estimate_time_to_level(700, 3, 100) == 0
        with pytest.raises(ValidationError):
            rank.estimate_time_to_level(0, 3, 0)

    def test_reports_no_cooldown_for_a_rule_without_one(self) -> None:
        rank = engine(rules=[create_event_rule("message", 10, cooldown_seconds=0)])
        assert rank.cooldown_remaining_ms(create_member_state(), "message", T0) == 0

    def test_reports_no_cooldown_for_an_unknown_event(self) -> None:
        assert engine().cooldown_remaining_ms(create_member_state(), "nope", T0) == 0


class TestConfiguration:
    def test_ships_a_usable_default(self) -> None:
        rank = RankEngine()
        assert isinstance(rank.curve, QuadraticCurve)
        assert (
            rank.award(create_member_state(), "message", now=T0).outcome
            is AwardOutcome.UNKNOWN_EVENT
        )

    def test_accepts_the_recommended_rule_set(self) -> None:
        rank = RankEngine(rules=default_rules())
        assert rank.rule_for("message").cooldown_seconds == 60  # type: ignore[union-attr]
        assert rank.rule_for("voice_minute").period_cap_xp == 1500  # type: ignore[union-attr]
        assert rank.rule_for("post").max_xp == 40  # type: ignore[union-attr]

    def test_defaults_max_to_min_when_omitted(self) -> None:
        rule = create_event_rule("ping", 3)
        assert rule.max_xp == 3
        assert rule.enabled is True
        assert rule.period_cap_xp is None

    def test_rejects_duplicate_event_types(self) -> None:
        with pytest.raises(ConfigurationError):
            RankEngine(
                rules=[create_event_rule("message", 1), create_event_rule("message", 2)]
            )

    def test_rejects_a_rule_that_is_not_an_event_rule(self) -> None:
        with pytest.raises(ConfigurationError):
            RankEngine(rules=[{"event_type": "message", "min_xp": 1}])  # type: ignore[list-item]

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"event_type": "", "min_xp": 1},
            {"event_type": GLOBAL_CAP_KEY, "min_xp": 1},
            {"event_type": "a", "min_xp": -1},
            {"event_type": "a", "min_xp": 10, "max_xp": 5},
            {"event_type": "a", "min_xp": 1, "cooldown_seconds": -1},
            {"event_type": "a", "min_xp": 1, "period_cap_xp": -5},
            {"event_type": "a", "min_xp": 1, "period_seconds": 0},
        ],
    )
    def test_rejects_impossible_rules(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ConfigurationError):
            create_event_rule(**kwargs)

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"global_cap": GlobalCap(xp=-1, period_seconds=10)},
            {"global_cap": GlobalCap(xp=10, period_seconds=0)},
            {"decay": DecayRule(xp_per_period=-1)},
            {"decay": DecayRule(xp_per_period=1, period_seconds=0)},
            {"decay": DecayRule(xp_per_period=1, floor_xp=0.5)},  # type: ignore[arg-type]
            {"decay": DecayRule(xp_per_period=1, grace_seconds=-1)},
            {"max_total_xp": 0},
            {"curve": "not a curve"},
        ],
    )
    def test_rejects_an_impossible_configuration(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ConfigurationError):
            RankEngine(**kwargs)

    def test_works_with_a_hand_written_curve(self) -> None:
        assert engine(curve=TabularCurve([0, 5, 25, 125])).level_for(30) == 2
