"""Curve shapes, threshold tables and progress."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from rankmode import (
    MAX_SUPPORTED_LEVEL,
    ConfigurationError,
    Curve,
    CurveError,
    ExponentialCurve,
    LinearCurve,
    QuadraticCurve,
    TabularCurve,
    ValidationError,
    create_curve,
    default_curve,
)


class TestLinearCurve:
    def test_charges_the_same_for_every_level(self) -> None:
        curve = LinearCurve(base=100, max_level=5)
        assert curve.thresholds == (0, 100, 200, 300, 400, 500)
        assert curve.max_level == 5

    @pytest.mark.parametrize(
        ("total_xp", "expected"),
        [(0, 0), (99, 0), (100, 1), (250, 2), (500, 5), (999_999, 5)],
    )
    def test_maps_totals_to_levels(self, total_xp: int, expected: int) -> None:
        assert LinearCurve(base=100, max_level=5).level_for_total_xp(total_xp) == expected

    def test_round_trips_through_create_curve(self) -> None:
        curve = LinearCurve(base=250, max_level=12)
        assert create_curve(curve.to_dict()).thresholds == curve.thresholds


class TestQuadraticCurve:
    def test_is_the_triangular_series(self) -> None:
        curve = QuadraticCurve(base=100, max_level=5)
        assert curve.thresholds == (0, 100, 300, 600, 1000, 1500)

    def test_never_produces_a_fractional_threshold(self) -> None:
        curve = QuadraticCurve(base=25, max_level=200)
        assert all(isinstance(t, int) for t in curve.thresholds)

    def test_costs_one_more_base_per_level(self) -> None:
        curve = QuadraticCurve(base=100, max_level=10)
        assert curve.xp_for_next_level(1) == 200
        assert curve.xp_for_next_level(2) == 300
        assert curve.xp_for_next_level(3) == 400

    def test_is_the_default_curve(self) -> None:
        assert isinstance(default_curve(), QuadraticCurve)


class TestExponentialCurve:
    def test_multiplies_the_level_cost(self) -> None:
        curve = ExponentialCurve(base=100, growth_permille=1500, max_level=5)
        # costs: 100, 150, 225, 337, 505
        assert curve.thresholds == (0, 100, 250, 475, 812, 1317)

    def test_forces_a_step_when_the_factor_floors_flat(self) -> None:
        curve = ExponentialCurve(base=7, growth_permille=1010, max_level=4)
        assert curve.thresholds[1] == 7
        steps = [
            curve.thresholds[level] - curve.thresholds[level - 1] for level in range(2, 5)
        ]
        assert all(step > 0 for step in steps)

    def test_stops_before_leaving_the_safe_range(self) -> None:
        curve = ExponentialCurve(base=100, growth_permille=2000, max_level=1000)
        assert curve.max_level < 1000
        assert curve.thresholds[curve.max_level] <= 9007199254740991

    @pytest.mark.parametrize("growth", [1000, 900, 0, -100])
    def test_rejects_a_factor_of_one_or_below(self, growth: int) -> None:
        with pytest.raises(ConfigurationError):
            ExponentialCurve(growth_permille=growth)


class TestTabularCurve:
    def test_takes_operator_supplied_thresholds(self) -> None:
        curve = TabularCurve([0, 10, 50, 500])
        assert curve.max_level == 3
        assert curve.level_for_total_xp(49) == 1
        assert curve.level_for_total_xp(50) == 2

    @pytest.mark.parametrize(
        "thresholds",
        [[10, 20], [0, 100, 100], [0, 100, 50], [0]],
    )
    def test_rejects_a_broken_table(self, thresholds: list[int]) -> None:
        with pytest.raises(ConfigurationError):
            TabularCurve(thresholds)

    def test_rejects_a_table_beyond_the_supported_range(self) -> None:
        with pytest.raises(ConfigurationError):
            TabularCurve([0, *range(1, MAX_SUPPORTED_LEVEL + 2)])

    def test_rejects_a_non_integer_threshold(self) -> None:
        with pytest.raises(ConfigurationError):
            TabularCurve([0, 10.5])  # type: ignore[list-item]


class TestProgress:
    curve = QuadraticCurve(base=100, max_level=5)

    def test_reports_the_position_inside_the_level(self) -> None:
        progress = self.curve.progress_for_total_xp(200)
        assert progress.level == 1
        assert progress.current_threshold == 100
        assert progress.next_threshold == 300
        assert progress.xp_into_level == 100
        assert progress.xp_to_next == 100
        assert progress.level_span == 200
        assert progress.progress_permille == 500
        assert progress.progress_ratio == 0.5
        assert progress.is_max_level is False

    def test_reports_a_full_bar_at_the_top(self) -> None:
        progress = self.curve.progress_for_total_xp(1500)
        assert progress.level == 5
        assert progress.next_threshold is None
        assert progress.xp_to_next is None
        assert progress.level_span is None
        assert progress.progress_permille == 1000
        assert progress.is_max_level is True

    def test_keeps_counting_past_the_top(self) -> None:
        progress = self.curve.progress_for_total_xp(99_999)
        assert progress.level == 5
        assert progress.xp_into_level == 99_999 - 1500

    def test_floors_rather_than_rounds(self) -> None:
        assert self.curve.progress_for_total_xp(199).progress_permille == 495
        assert self.curve.progress_for_total_xp(101).progress_permille == 5

    def test_treats_a_negative_total_as_level_zero(self) -> None:
        progress = self.curve.progress_for_total_xp(-50)
        assert progress.level == 0
        assert progress.xp_into_level == -50
        assert progress.progress_permille == 0


class TestCurveErrors:
    curve = QuadraticCurve(base=100, max_level=3)

    def test_refuses_a_level_above_the_curve(self) -> None:
        with pytest.raises(CurveError):
            self.curve.total_xp_for_level(4)
        with pytest.raises(CurveError):
            self.curve.xp_for_next_level(3)

    @pytest.mark.parametrize("level", [-1, 1.5, "2"])
    def test_refuses_an_impossible_level(self, level: object) -> None:
        with pytest.raises(ValidationError):
            self.curve.total_xp_for_level(level)  # type: ignore[arg-type]

    def test_refuses_a_non_integer_total(self) -> None:
        with pytest.raises(ValidationError):
            self.curve.level_for_total_xp(1.5)  # type: ignore[arg-type]

    def test_treats_level_zero_as_the_first_level_cost(self) -> None:
        assert self.curve.xp_for_next_level(0) == 100

    @pytest.mark.parametrize(
        "factory",
        [
            lambda: LinearCurve(base=0),
            lambda: QuadraticCurve(base=-5),
            lambda: LinearCurve(max_level=0),
            lambda: LinearCurve(max_level=MAX_SUPPORTED_LEVEL + 1),
        ],
    )
    def test_refuses_an_unusable_configuration(self, factory: Callable[[], Curve]) -> None:
        with pytest.raises(ConfigurationError):
            factory()

    def test_refuses_an_unknown_curve_kind(self) -> None:
        with pytest.raises(ConfigurationError):
            create_curve({"kind": "spiral"})

    def test_refuses_a_tabular_spec_without_thresholds(self) -> None:
        with pytest.raises(ConfigurationError):
            create_curve({"kind": "tabular"})


class TestSerialisation:
    def test_round_trips_every_generated_shape(self) -> None:
        curves = [
            LinearCurve(base=60, max_level=8),
            QuadraticCurve(base=75, max_level=9),
            ExponentialCurve(base=40, growth_permille=1250, max_level=7),
        ]
        for curve in curves:
            spec = curve.to_dict()
            assert spec["kind"] == curve.kind
            assert create_curve(spec).thresholds == curve.thresholds

    def test_accepts_the_python_spelling_of_a_spec(self) -> None:
        curve = create_curve(
            {"kind": "exponential", "base": 40, "growth_permille": 1250, "max_level": 7}
        )
        assert curve.thresholds == ExponentialCurve(40, 1250, 7).thresholds

    def test_serialises_a_hand_written_table_as_a_table(self) -> None:
        curve = TabularCurve([0, 10, 40, 90])
        assert curve.to_dict() == {"kind": "tabular", "thresholds": [0, 10, 40, 90]}

    def test_curves_compare_by_their_table(self) -> None:
        assert LinearCurve(base=100, max_level=3) == TabularCurve([0, 100, 200, 300])
        assert LinearCurve(base=100, max_level=3) != LinearCurve(base=50, max_level=3)
        assert LinearCurve(base=100, max_level=3).__eq__("not a curve") is NotImplemented
        assert len({LinearCurve(base=100, max_level=3), TabularCurve([0, 100, 200, 300])}) == 1
