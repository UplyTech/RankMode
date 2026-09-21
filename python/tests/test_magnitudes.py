"""The numbers the rest of the suite never reaches.

Every shared vector probes totals up to 1,000,000 and curve bases up to 100.
Every other unit test works in the same range. That is why three separate
divergences between the two editions survived 473 tests: all of them appear only
when an *intermediate* product passes 2**53 - 1, while the inputs and the answer
stay comfortably inside it.

Python integers do not lose precision, so this edition was already right in all
three places. These tests exist anyway, and mirror
``typescript/tests/magnitudes.test.ts`` case for case: the expectations are what
makes "both editions agree" a statement about pinned numbers rather than about
two suites that happen to be green.
"""

from __future__ import annotations

import pytest

from rankmode import (
    MAX_TOTAL_XP,
    ConfigurationError,
    ExponentialCurve,
    LinearCurve,
    MigrationStrategy,
    Multiplier,
    QuadraticCurve,
    RankEngine,
    TabularCurve,
    XpOverflowError,
    apply_multipliers,
    combined_permille,
    create_event_rule,
    create_member_state,
    migrate_total_xp,
)
from rankmode.types import AwardOutcome


class TestExponentialCurvesAtScale:
    @pytest.mark.parametrize(
        ("base", "growth_permille", "level", "expected"),
        [
            (1_000_000_003, 1500, 30, 383500119396580),
            (999, 3000, 24, 141073553471760),
            (1_000_000_003, 3000, 15, 7174453021523359),
            (9_007_199_254_740, 1500, 8, 443674932040112),
        ],
    )
    def test_agrees_with_the_typescript_edition(
        self, base: int, growth_permille: int, level: int, expected: int
    ) -> None:
        curve = ExponentialCurve(base=base, growth_permille=growth_permille, max_level=500)
        assert curve.thresholds[level] == expected

    def test_every_threshold_stays_inside_the_shared_range(self) -> None:
        curve = ExponentialCurve(base=9_007_199_254_740, growth_permille=1500, max_level=500)
        for level in range(1, curve.max_level + 1):
            assert curve.thresholds[level] > curve.thresholds[level - 1]
            assert curve.thresholds[level] <= MAX_TOTAL_XP


class TestGeneratedCurvesWithALargeBase:
    def test_linear_table_is_exact(self) -> None:
        curve = LinearCurve(base=9_007_199_254_740, max_level=1000)
        assert curve.max_level == 1000
        assert all(value <= MAX_TOTAL_XP for value in curve.thresholds)

    def test_refuses_a_base_too_large_to_reach_level_one(self) -> None:
        # The table would truncate to [0] - a curve nobody can ever level up in,
        # reported as if it were fine.
        with pytest.raises(ConfigurationError):
            LinearCurve(base=MAX_TOTAL_XP + 1, max_level=10)
        with pytest.raises(ConfigurationError):
            QuadraticCurve(base=MAX_TOTAL_XP + 1, max_level=10)
        # One below is still a usable, if absurd, curve with exactly one level.
        assert LinearCurve(base=MAX_TOTAL_XP, max_level=10).max_level == 1

    def test_quadratic_table_is_the_triangular_series(self) -> None:
        base = 9_007_199_254_740
        curve = QuadraticCurve(base=base, max_level=1000)
        assert curve.max_level == 44
        assert curve.thresholds[44] == 8917127262192600
        for level in range(curve.max_level + 1):
            assert curve.thresholds[level] == base * level * (level + 1) // 2


class TestProgressOnAWideLevel:
    @pytest.mark.parametrize(
        ("span", "into", "permille"),
        [
            (5002985382580839, 3191904674086575, 637),
            (7258011449013000, 6430598143825518, 886),
            (5307722243584428, 3216479679612163, 605),
            (5671046042530894, 4327008130451072, 762),
            (7379154009697730, 7371774855688032, 998),
        ],
    )
    def test_reports_the_same_permille_as_typescript(
        self, span: int, into: int, permille: int
    ) -> None:
        curve = TabularCurve([0, span, MAX_TOTAL_XP])
        assert curve.progress_for_total_xp(into).progress_permille == permille

    def test_never_reports_more_than_full(self) -> None:
        curve = TabularCurve([0, 4503599627370496, MAX_TOTAL_XP])
        for total in (0, 1, 4503599627370495, 4503599627370496, MAX_TOTAL_XP):
            permille = curve.progress_for_total_xp(total).progress_permille
            assert 0 <= permille <= 1000


class TestMultiplierChainsAtScale:
    def test_multiplies_exactly_where_a_double_would_round(self) -> None:
        assert apply_multipliers(2848452375478271, [Multiplier("r", 2490)]) == (
            7092646414940894
        )

    def test_floors_at_every_step_all_the_way_down_a_chain(self) -> None:
        expected = 4_503_599_627_370
        chain = [
            Multiplier(f"s{index}", permille)
            for index, permille in enumerate([1500, 999, 1001, 700, 1234])
        ]
        for multiplier in chain:
            expected = expected * multiplier.permille // 1000
        assert apply_multipliers(4_503_599_627_370, chain) == expected

    def test_refuses_a_chain_that_leaves_the_shared_safe_range(self) -> None:
        # Python could hold the answer; the TypeScript edition could not. A
        # total only one edition can hold is exactly what the shared range
        # exists to prevent, so this edition refuses it too.
        with pytest.raises(XpOverflowError):
            apply_multipliers(MAX_TOTAL_XP, [Multiplier("double-xp", 2000)])

        assert (
            combined_permille([Multiplier("a", 1_000_000_000), Multiplier("b", 1_000_000_000)])
            == 1_000_000_000_000_000
        )
        with pytest.raises(XpOverflowError):
            combined_permille([Multiplier(f"s{i}", 1_000_000_000) for i in range(3)])


class TestMigrationBetweenWideCurves:
    def test_carries_the_progress_bar_across_without_rounding_it(self) -> None:
        source = TabularCurve([0, 1000, 2000])
        target = TabularCurve([0, 4503599627370496, MAX_TOTAL_XP])
        result = migrate_total_xp(1234, source, target, MigrationStrategy.PRESERVE_PROGRESS)
        assert result.new_total_xp == 5557441940175191
        assert result.new_level == 1


class TestTheCeiling:
    def test_awards_exactly_the_headroom_and_no_more(self) -> None:
        engine = RankEngine(
            curve=QuadraticCurve(base=100, max_level=10),
            rules=[create_event_rule("message", 1000, 1000)],
        )
        state = create_member_state(MAX_TOTAL_XP - 7)
        result = engine.award(state, "message", now=1)
        assert result.awarded_xp == 7
        assert result.new_total_xp == MAX_TOTAL_XP

        again = engine.award(result.state, "message", now=2)
        assert again.outcome is AwardOutcome.MAX_XP_REACHED
        assert again.new_total_xp == MAX_TOTAL_XP
