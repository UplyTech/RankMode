"""The invariants, stated as invariants rather than as three examples each.

The rest of the suite pins down specific numbers, which is the right way to test
a formula. It is the wrong way to test a *rule* — "a sequence of awards never
exceeds the period cap" is true of every sequence, and three examples of it
prove three sequences.

Everything here is a property the library must hold for any input in range.
Hypothesis is a development dependency only; the promise of zero runtime
dependencies is unaffected, and CI checks it.
"""

from __future__ import annotations

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from rankmode import (
    MAX_TOTAL_XP,
    Curve,
    ExponentialCurve,
    LinearCurve,
    MigrationStrategy,
    Multiplier,
    QuadraticCurve,
    RankEngine,
    TabularCurve,
    TieMode,
    apply_multipliers,
    build_leaderboard,
    create_event_rule,
    create_member_state,
    migrate_total_xp,
    rank_of,
    serialize_member_state,
)
from rankmode.random_source import FixedRandomSource
from rankmode.state import deserialize_member_state
from rankmode.types import AwardOutcome

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

#: Bases that reach past 2**53 in an intermediate product as well as ordinary
#: ones. A strategy that only produces small numbers tests only small numbers.
bases = st.sampled_from([1, 7, 25, 100, 999, 1_000_000, 1_000_000_003, 9_007_199_254_740])

totals = st.integers(min_value=0, max_value=MAX_TOTAL_XP)

curves = st.one_of(
    st.builds(LinearCurve, base=bases, max_level=st.integers(min_value=1, max_value=200)),
    st.builds(QuadraticCurve, base=bases, max_level=st.integers(min_value=1, max_value=200)),
    st.builds(
        ExponentialCurve,
        base=bases,
        growth_permille=st.sampled_from([1001, 1100, 1500, 2000, 3000]),
        max_level=st.integers(min_value=1, max_value=200),
    ),
)


@st.composite
def tabular_curves(draw: st.DrawFn) -> TabularCurve:
    steps = draw(st.lists(st.integers(min_value=1, max_value=10**12), min_size=1, max_size=15))
    thresholds = [0]
    for step in steps:
        thresholds.append(thresholds[-1] + step)
    return TabularCurve(thresholds)


any_curve = st.one_of(curves, tabular_curves())


# ---------------------------------------------------------------------------
# Curves
# ---------------------------------------------------------------------------
class TestCurveProperties:
    @given(curve=any_curve)
    def test_thresholds_ascend_strictly_from_zero(self, curve: Curve) -> None:
        assert curve.thresholds[0] == 0
        for level in range(1, curve.max_level + 1):
            assert curve.thresholds[level] > curve.thresholds[level - 1]

    @given(curve=any_curve, data=st.data())
    def test_a_level_round_trips_through_its_threshold(
        self, curve: Curve, data: st.DataObject
    ) -> None:
        level = data.draw(st.integers(min_value=0, max_value=curve.max_level))
        assert curve.level_for_total_xp(curve.total_xp_for_level(level)) == level

    @given(curve=any_curve, total_xp=totals)
    def test_one_below_a_threshold_is_one_level_lower(
        self, curve: Curve, total_xp: int
    ) -> None:
        level = curve.level_for_total_xp(total_xp)
        assert curve.thresholds[level] <= total_xp
        if level < curve.max_level:
            assert total_xp < curve.thresholds[level + 1]

    @given(curve=any_curve, total_xp=totals)
    def test_progress_stays_in_range_and_is_consistent(
        self, curve: Curve, total_xp: int
    ) -> None:
        progress = curve.progress_for_total_xp(total_xp)
        assert 0 <= progress.progress_permille <= 1000
        assert progress.total_xp == total_xp
        assert progress.level == curve.level_for_total_xp(total_xp)
        assert progress.current_threshold + progress.xp_into_level == total_xp
        if progress.next_threshold is not None:
            assert progress.xp_to_next is not None
            assert progress.total_xp + progress.xp_to_next == progress.next_threshold
            assert progress.level_span == (
                progress.next_threshold - progress.current_threshold
            )
        else:
            assert progress.is_max_level
            assert progress.progress_permille == 1000


# ---------------------------------------------------------------------------
# Multipliers
# ---------------------------------------------------------------------------
class TestMultiplierProperties:
    @given(
        base_xp=st.integers(min_value=0, max_value=10**9),
        permilles=st.lists(st.integers(min_value=0, max_value=5000), min_size=0, max_size=6),
    )
    def test_matches_step_by_step_floor_division(
        self, base_xp: int, permilles: list[int]
    ) -> None:
        chain = [Multiplier(f"s{i}", p) for i, p in enumerate(permilles)]
        expected = base_xp
        for permille in permilles:
            expected = expected * permille // 1000
        assert apply_multipliers(base_xp, chain) == expected

    @given(base_xp=st.integers(min_value=0, max_value=10**9))
    def test_an_empty_chain_changes_nothing(self, base_xp: int) -> None:
        assert apply_multipliers(base_xp, []) == base_xp

    @given(
        base_xp=st.integers(min_value=0, max_value=10**9),
        permille=st.integers(min_value=0, max_value=1000),
    )
    def test_a_factor_at_or_below_one_never_increases_the_value(
        self, base_xp: int, permille: int
    ) -> None:
        assert apply_multipliers(base_xp, [Multiplier("r", permille)]) <= base_xp


# ---------------------------------------------------------------------------
# Awards
# ---------------------------------------------------------------------------
class TestAwardProperties:
    @given(
        initial=st.integers(min_value=0, max_value=10**6),
        min_xp=st.integers(min_value=0, max_value=50),
        extra=st.integers(min_value=0, max_value=50),
        cap=st.integers(min_value=1, max_value=500),
        rolls=st.lists(st.integers(min_value=0, max_value=100), min_size=1, max_size=10),
        step_count=st.integers(min_value=1, max_value=30),
    )
    @settings(max_examples=200)
    def test_a_sequence_never_exceeds_the_period_cap(
        self,
        initial: int,
        min_xp: int,
        extra: int,
        cap: int,
        rolls: list[int],
        step_count: int,
    ) -> None:
        engine = RankEngine(
            curve=QuadraticCurve(base=100, max_level=100),
            rules=[
                create_event_rule(
                    "message",
                    min_xp,
                    min_xp + extra,
                    cooldown_seconds=0,
                    period_cap_xp=cap,
                    period_seconds=86400,
                )
            ],
        )
        source = FixedRandomSource(rolls, cycle=True)
        state = create_member_state(initial)
        now = 1_700_000_000_000

        awarded = 0
        for step in range(step_count):
            # Every step inside one period, so the cap cannot reset.
            result = engine.award(
                state, "message", now=now + step * 1000, random_source=source
            )
            awarded += result.awarded_xp
            state = result.state

        assert awarded <= cap
        assert state.total_xp == initial + awarded

    @given(
        initial=st.integers(min_value=0, max_value=10**9),
        amount=st.integers(min_value=0, max_value=10**9),
    )
    def test_the_signed_delta_always_matches_the_totals(
        self, initial: int, amount: int
    ) -> None:
        engine = RankEngine(curve=QuadraticCurve(base=100, max_level=200))
        result = engine.penalize(create_member_state(initial), amount, now=1)
        assert result.new_total_xp - result.previous_total_xp == result.awarded_xp
        assert result.changed == (result.awarded_xp != 0)
        assert result.new_total_xp >= 0

    @given(
        initial=st.integers(min_value=0, max_value=10**6),
        base_xp=st.integers(min_value=0, max_value=1000),
    )
    def test_the_state_handed_in_is_never_mutated(self, initial: int, base_xp: int) -> None:
        engine = RankEngine(
            curve=QuadraticCurve(base=100, max_level=100),
            rules=[create_event_rule("message", 10, 20, cooldown_seconds=60)],
        )
        state = create_member_state(initial)
        before = serialize_member_state(state)
        engine.award(state, "message", now=1, base_xp=base_xp)
        assert serialize_member_state(state) == before

    @given(
        initial=st.integers(min_value=0, max_value=10**9),
        base_xp=st.integers(min_value=0, max_value=10**6),
    )
    def test_an_outcome_that_is_not_awarded_changes_nothing(
        self, initial: int, base_xp: int
    ) -> None:
        engine = RankEngine(
            curve=QuadraticCurve(base=100, max_level=200),
            rules=[create_event_rule("message", 1, 1, cooldown_seconds=60)],
        )
        state = create_member_state(initial)
        first = engine.award(state, "message", now=1, base_xp=base_xp)
        blocked = engine.award(first.state, "message", now=2, base_xp=base_xp)

        assert blocked.outcome is not AwardOutcome.AWARDED
        assert blocked.awarded_xp == 0
        assert blocked.changed is False
        assert blocked.new_total_xp == blocked.previous_total_xp
        assert blocked.leveled_up is False


# ---------------------------------------------------------------------------
# Leaderboards
# ---------------------------------------------------------------------------
class TestLeaderboardProperties:
    @given(
        rows=st.lists(
            st.tuples(st.text(min_size=1, max_size=8), totals), min_size=0, max_size=40
        ),
        tie_mode=st.sampled_from(list(TieMode)),
    )
    def test_a_board_is_a_permutation_of_its_input(
        self, rows: list[tuple[str, int]], tie_mode: TieMode
    ) -> None:
        curve = QuadraticCurve(base=100, max_level=200)
        board = build_leaderboard(curve, rows, tie_mode=tie_mode)
        assert len(board) == len(rows)
        assert sorted(entry.total_xp for entry in board) == sorted(
            total for _member, total in rows
        )

    @given(
        rows=st.lists(
            st.tuples(st.text(min_size=1, max_size=8), totals), min_size=1, max_size=40
        ),
        tie_mode=st.sampled_from(list(TieMode)),
    )
    def test_totals_never_increase_down_the_board(
        self, rows: list[tuple[str, int]], tie_mode: TieMode
    ) -> None:
        curve = QuadraticCurve(base=100, max_level=200)
        board = build_leaderboard(curve, rows, tie_mode=tie_mode)
        for previous, entry in zip(board, board[1:], strict=False):
            assert entry.total_xp <= previous.total_xp
            assert entry.rank >= previous.rank

    @given(
        rows=st.lists(
            st.tuples(st.text(min_size=1, max_size=8), totals), min_size=1, max_size=25
        ),
        tie_mode=st.sampled_from(list(TieMode)),
    )
    def test_rank_of_agrees_with_the_whole_board(
        self, rows: list[tuple[str, int]], tie_mode: TieMode
    ) -> None:
        # Duplicate ids would make "the" rank ambiguous, and build_leaderboard
        # keeps both rows while rank_of finds the first.
        assume(len({member for member, _total in rows}) == len(rows))
        curve = QuadraticCurve(base=100, max_level=200)
        board = build_leaderboard(curve, rows, tie_mode=tie_mode)
        for entry in board:
            assert rank_of(entry.member_id, rows, tie_mode=tie_mode) == entry.rank


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------
class TestMigrationProperties:
    @given(source=any_curve, target=any_curve, total_xp=st.integers(0, 10**7))
    def test_no_member_ever_loses_a_level_except_by_clamping(
        self, source: Curve, target: Curve, total_xp: int
    ) -> None:
        for strategy in (
            MigrationStrategy.PRESERVE_LEVEL,
            MigrationStrategy.PRESERVE_PROGRESS,
        ):
            result = migrate_total_xp(total_xp, source, target, strategy)
            if result.clamped_to_curve_top:
                # The new curve simply does not go that high.
                assert result.new_level == target.max_level
            else:
                assert result.level_delta == 0

    @given(source=any_curve, target=any_curve, total_xp=st.integers(0, 10**7))
    def test_a_migration_never_hands_out_a_free_level(
        self, source: Curve, target: Curve, total_xp: int
    ) -> None:
        result = migrate_total_xp(
            total_xp, source, target, MigrationStrategy.PRESERVE_PROGRESS
        )
        assert result.level_delta <= 0

    @given(curve=any_curve, total_xp=st.integers(0, 10**7))
    def test_migrating_to_the_same_curve_changes_nothing(
        self, curve: Curve, total_xp: int
    ) -> None:
        result = migrate_total_xp(total_xp, curve, curve, MigrationStrategy.PRESERVE_XP)
        assert result.new_total_xp == total_xp
        assert result.level_delta == 0


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
class TestStateProperties:
    @given(
        total_xp=totals,
        stamps=st.dictionaries(
            st.text(min_size=1, max_size=6), st.integers(0, 10**13), max_size=5
        ),
        last_decay_at=st.one_of(st.none(), st.integers(0, 10**13)),
    )
    def test_serialisation_round_trips(
        self,
        total_xp: int,
        stamps: dict[str, int],
        last_decay_at: int | None,
    ) -> None:
        state = create_member_state(total_xp)
        state.last_event_at = dict(stamps)
        state.period_start_at = dict(stamps)
        state.period_awarded_xp = dict(stamps)
        state.last_decay_at = last_decay_at

        restored = deserialize_member_state(serialize_member_state(state))
        assert serialize_member_state(restored) == serialize_member_state(state)
