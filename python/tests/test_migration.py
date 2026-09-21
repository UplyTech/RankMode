"""Curve migration: what a curve change does to the members."""

from __future__ import annotations

import pytest

from rankmode import (
    Curve,
    ExponentialCurve,
    LinearCurve,
    MigrationError,
    MigrationStrategy,
    QuadraticCurve,
    migrate_all,
    migrate_total_xp,
    preview_migration,
)

LINEAR = LinearCurve(base=100, max_level=50)
QUADRATIC = QuadraticCurve(base=100, max_level=50)
EXPONENTIAL = ExponentialCurve(base=100, growth_permille=1500, max_level=50)


class TestMigrateTotalXp:
    def test_preserves_the_level_and_the_bar_by_default(self) -> None:
        # linear: level 3 at 300, level 4 at 400, so 350 is halfway.
        result = migrate_total_xp(350, LINEAR, QUADRATIC)
        assert result.previous_level == 3
        assert result.new_level == 3
        assert result.previous_progress_permille == 500
        # quadratic: level 3 at 600, level 4 at 1000 -> halfway is 800.
        assert result.new_total_xp == 800
        assert result.new_progress_permille == 500
        assert result.level_delta == 0

    def test_can_empty_the_bar_instead(self) -> None:
        result = migrate_total_xp(350, LINEAR, QUADRATIC, MigrationStrategy.PRESERVE_LEVEL)
        assert result.new_level == 3
        assert result.new_total_xp == 600
        assert result.new_progress_permille == 0

    def test_can_keep_the_raw_total(self) -> None:
        result = migrate_total_xp(350, LINEAR, QUADRATIC, MigrationStrategy.PRESERVE_XP)
        assert result.new_total_xp == 350
        assert result.previous_level == 3
        # quadratic level 2 starts at 300, level 3 at 600 -- the member drops one.
        assert result.new_level == 2
        assert result.level_delta == -1

    def test_never_gives_a_free_level_through_rounding(self) -> None:
        for total_xp in range(0, 5001, 7):
            assert migrate_total_xp(total_xp, LINEAR, QUADRATIC).level_delta == 0

    @pytest.mark.parametrize(
        ("source", "target"),
        [
            (QUADRATIC, LINEAR),
            (QUADRATIC, EXPONENTIAL),
            (EXPONENTIAL, QUADRATIC),
            (LINEAR, EXPONENTIAL),
        ],
    )
    def test_never_takes_a_level_away(self, source: Curve, target: Curve) -> None:
        for total_xp in range(0, 5001, 13):
            assert migrate_total_xp(total_xp, source, target).level_delta == 0

    def test_is_a_no_op_between_identical_curves(self) -> None:
        same = QuadraticCurve(base=100, max_level=50)
        assert migrate_total_xp(1234, QUADRATIC, same).new_total_xp == 1234

    def test_clamps_a_member_above_the_top_of_the_new_curve(self) -> None:
        short = LinearCurve(base=100, max_level=3)
        result = migrate_total_xp(QUADRATIC.total_xp_for_level(10), QUADRATIC, short)
        assert result.new_level == 3
        assert result.clamped_to_curve_top is True

    def test_handles_a_member_at_level_zero(self) -> None:
        result = migrate_total_xp(0, LINEAR, QUADRATIC)
        assert result.new_total_xp == 0
        assert result.new_level == 0

    def test_rejects_an_unknown_strategy(self) -> None:
        with pytest.raises(MigrationError):
            migrate_total_xp(100, LINEAR, QUADRATIC, "SPIN")  # type: ignore[arg-type]


class TestMigrateAll:
    def test_keeps_the_input_order(self) -> None:
        results = migrate_all([0, 100, 350, 1000], LINEAR, QUADRATIC)
        assert [r.previous_total_xp for r in results] == [0, 100, 350, 1000]


class TestPreviewMigration:
    TOTALS = [0, 50, 150, 350, 900, 5000]

    def test_summarises_what_the_switch_would_do(self) -> None:
        report = preview_migration(self.TOTALS, LINEAR, QUADRATIC)
        assert report.member_count == 6
        assert report.unchanged == 6
        assert report.lost_levels == 0
        assert report.safe_for_members is True
        assert report.total_xp_before == 6450
        assert report.total_xp_after > report.total_xp_before

    def test_flags_a_strategy_that_costs_levels(self) -> None:
        report = preview_migration(
            self.TOTALS, LINEAR, QUADRATIC, MigrationStrategy.PRESERVE_XP
        )
        assert report.safe_for_members is False
        assert report.lost_levels > 0
        assert report.max_loss > 0
        assert report.total_xp_after == report.total_xp_before

    def test_counts_gained_levels_too(self) -> None:
        report = preview_migration(
            self.TOTALS, QUADRATIC, LINEAR, MigrationStrategy.PRESERVE_XP
        )
        assert report.gained_levels > 0
        assert report.max_gain > 0

    def test_handles_an_empty_scope(self) -> None:
        report = preview_migration([], LINEAR, QUADRATIC)
        assert report.member_count == 0
        assert report.safe_for_members is True
