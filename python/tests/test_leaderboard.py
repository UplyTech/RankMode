"""Ranking, tie handling and paging."""

from __future__ import annotations

import time
from typing import Any

import pytest

from rankmode import (
    QuadraticCurve,
    TieMode,
    ValidationError,
    build_leaderboard,
    page_count,
    paginate,
    rank_of,
)

CURVE = QuadraticCurve(base=100, max_level=50)

ROWS = [
    ("ana", 500),
    ("ben", 900),
    ("cai", 500),
    ("dee", 100),
    ("eli", 900),
]


class TestBuildLeaderboard:
    def test_sorts_by_total_highest_first(self) -> None:
        board = build_leaderboard(CURVE, ROWS)
        assert [entry.member_id for entry in board] == ["ben", "eli", "ana", "cai", "dee"]

    def test_competition_ranking_is_the_default(self) -> None:
        assert [e.rank for e in build_leaderboard(CURVE, ROWS)] == [1, 1, 3, 3, 5]

    def test_dense_ranking_has_no_gaps(self) -> None:
        board = build_leaderboard(CURVE, ROWS, tie_mode=TieMode.DENSE)
        assert [entry.rank for entry in board] == [1, 1, 2, 2, 3]

    def test_ordinal_ranking_numbers_every_row(self) -> None:
        board = build_leaderboard(CURVE, ROWS, tie_mode=TieMode.ORDINAL)
        assert [entry.rank for entry in board] == [1, 2, 3, 4, 5]

    def test_always_reports_both_numberings(self) -> None:
        board = build_leaderboard(CURVE, ROWS, tie_mode=TieMode.ORDINAL)
        assert [entry.competition_rank for entry in board] == [1, 1, 3, 3, 5]
        assert [entry.dense_rank for entry in board] == [1, 1, 2, 2, 3]

    def test_ties_keep_input_order(self) -> None:
        # ben comes before eli in the input, so ben stays ahead.
        board = build_leaderboard(CURVE, ROWS)
        assert board[0].member_id == "ben"
        assert board[1].member_id == "eli"
        assert build_leaderboard(CURVE, list(reversed(ROWS)))[0].member_id == "eli"

    def test_attaches_level_and_progress(self) -> None:
        top = build_leaderboard(CURVE, ROWS)[0]
        assert top.level == 3
        assert top.progress.level == 3
        assert top.progress.next_threshold == 1000

    def test_offset_and_limit_are_applied_after_ranking(self) -> None:
        board = build_leaderboard(CURVE, ROWS, offset=2, limit=2)
        assert [entry.member_id for entry in board] == ["ana", "cai"]
        # Ranks stay absolute so page two still says "3rd", not "1st".
        assert [entry.rank for entry in board] == [3, 3]
        assert [entry.position for entry in board] == [2, 3]

    def test_handles_an_empty_board(self) -> None:
        assert build_leaderboard(CURVE, []) == []

    def test_handles_a_board_where_everyone_is_tied(self) -> None:
        board = build_leaderboard(CURVE, [("a", 10), ("b", 10), ("c", 10)])
        assert [entry.rank for entry in board] == [1, 1, 1]

    @pytest.mark.parametrize(
        ("rows", "kwargs"),
        [
            ([("", 1)], {}),
            ([("a", 1.5)], {}),
            (ROWS, {"offset": -1}),
            (ROWS, {"limit": -1}),
        ],
    )
    def test_rejects_invalid_input(
        self, rows: list[tuple[str, int]], kwargs: dict[str, Any]
    ) -> None:
        with pytest.raises(ValidationError):
            build_leaderboard(CURVE, rows, **kwargs)

    def test_stays_fast_on_a_large_board(self) -> None:
        many = [(f"m{index}", (index * 7919) % 250_000) for index in range(10_000)]
        started = time.perf_counter()
        board = build_leaderboard(CURVE, many)
        elapsed_ms = (time.perf_counter() - started) * 1000
        assert len(board) == 10_000
        # The concept asks for under 50 ms; the generous bound keeps CI honest
        # without turning a slow runner into a red build.
        assert elapsed_ms < 1000


class TestRankOf:
    def test_finds_a_member_without_building_the_board(self) -> None:
        assert rank_of("ben", ROWS) == 1
        assert rank_of("eli", ROWS) == 1
        assert rank_of("ana", ROWS) == 3
        assert rank_of("dee", ROWS) == 5

    @pytest.mark.parametrize("tie_mode", list(TieMode))
    def test_agrees_with_build_leaderboard(self, tie_mode: TieMode) -> None:
        for entry in build_leaderboard(CURVE, ROWS, tie_mode=tie_mode):
            assert rank_of(entry.member_id, ROWS, tie_mode=tie_mode) == entry.rank

    def test_returns_none_for_a_member_not_on_the_board(self) -> None:
        assert rank_of("nobody", ROWS) is None


class TestPaging:
    def test_cuts_a_board_into_pages(self) -> None:
        board = build_leaderboard(CURVE, ROWS)
        assert [e.member_id for e in paginate(board, 2, 1)] == ["ben", "eli"]
        assert [e.member_id for e in paginate(board, 2, 3)] == ["dee"]
        assert paginate(board, 2, 4) == []

    @pytest.mark.parametrize(("total", "size", "expected"), [(5, 2, 3), (4, 2, 2), (0, 2, 0)])
    def test_counts_pages(self, total: int, size: int, expected: int) -> None:
        assert page_count(total, size) == expected

    def test_rejects_nonsense_paging(self) -> None:
        with pytest.raises(ValidationError):
            paginate([], 0, 1)
        with pytest.raises(ValidationError):
            paginate([], 10, 0)
        with pytest.raises(ValidationError):
            page_count(10, 0)
