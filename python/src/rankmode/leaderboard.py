"""Turning a list of totals into a ranked leaderboard.

The library ranks; it does not fetch. Sorting a hundred thousand rows is a job
for the database that already holds them, so the caller selects the rows it
wants to show and hands them over. What the library contributes is the part
that is easy to get wrong and identical everywhere: the tie handling.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from .curves import Curve
from .errors import ValidationError
from .types import LeaderboardEntry, TieMode

__all__ = ["build_leaderboard", "rank_of", "paginate", "page_count"]

#: A row as the caller hands it in: member id and total.
LeaderboardRow = tuple[str, int]


def build_leaderboard(
    curve: Curve,
    rows: Iterable[LeaderboardRow],
    tie_mode: TieMode = TieMode.COMPETITION,
    offset: int = 0,
    limit: int | None = None,
) -> list[LeaderboardEntry]:
    """Rank ``rows`` and return them highest first.

    Ties keep the order in which they were handed in. That is a deliberate
    choice over a tie-break on the member id: string comparison differs between
    Python (code points) and JavaScript (UTF-16 code units) for characters
    outside the basic plane, and the two editions must never disagree.

    ``offset`` and ``limit`` are applied *after* ranking, so page two still
    says "3rd", not "1st".
    """
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValidationError("offset must be a non-negative integer", offset=offset)
    if limit is not None and (
        not isinstance(limit, int) or isinstance(limit, bool) or limit < 0
    ):
        raise ValidationError("limit must be a non-negative integer or None", limit=limit)

    materialised = list(rows)
    for index, row in enumerate(materialised):
        member_id, total_xp = row
        if not isinstance(member_id, str) or not member_id:
            raise ValidationError(
                "Every leaderboard row needs a non-empty member id", index=index
            )
        if not isinstance(total_xp, int) or isinstance(total_xp, bool):
            raise ValidationError(
                "Leaderboard totals must be integers", index=index, total_xp=total_xp
            )

    # Python's sort is stable, so sorting on the total alone already keeps the
    # input order among ties. The explicit index keeps that guarantee visible.
    ordered = sorted(enumerate(materialised), key=lambda item: (-item[1][1], item[0]))

    entries: list[LeaderboardEntry] = []
    competition_rank = 0
    dense_rank = 0
    previous_total: int | None = None

    for position, (_input_index, (member_id, total_xp)) in enumerate(ordered):
        if previous_total is None or total_xp != previous_total:
            competition_rank = position + 1
            dense_rank += 1
            previous_total = total_xp

        progress = curve.progress_for_total_xp(total_xp)
        if tie_mode is TieMode.DENSE:
            rank = dense_rank
        elif tie_mode is TieMode.ORDINAL:
            rank = position + 1
        else:
            rank = competition_rank

        entries.append(
            LeaderboardEntry(
                member_id=member_id,
                total_xp=total_xp,
                level=progress.level,
                rank=rank,
                competition_rank=competition_rank,
                dense_rank=dense_rank,
                position=position,
                progress=progress,
            )
        )

    end = len(entries) if limit is None else offset + limit
    return entries[offset:end]


def rank_of(
    member_id: str,
    rows: Iterable[LeaderboardRow],
    tie_mode: TieMode = TieMode.COMPETITION,
) -> int | None:
    """The rank of a single member inside a set of totals.

    Returns ``None`` when the member is not in the list. Useful for the
    "you are #47" line under a level card, where building the whole board would
    be wasteful.
    """
    materialised = list(rows)
    target_index = None
    for index, (candidate, _total) in enumerate(materialised):
        if candidate == member_id:
            target_index = index
            break
    if target_index is None:
        return None

    target_total = materialised[target_index][1]

    if tie_mode is TieMode.DENSE:
        higher = {total for _member, total in materialised if total > target_total}
        return len(higher) + 1

    if tie_mode is TieMode.ORDINAL:
        position = 0
        for index, (_member, total) in enumerate(materialised):
            if total > target_total:
                position += 1
            elif total == target_total and index < target_index:
                # Ties keep input order, so only rows before the target count.
                position += 1
        return position + 1

    ahead = sum(1 for _member, total in materialised if total > target_total)
    return ahead + 1


def paginate(
    entries: Sequence[LeaderboardEntry], page_size: int, page: int
) -> list[LeaderboardEntry]:
    """Cut a board into pages of a fixed size. ``page`` is 1-based."""
    if not isinstance(page_size, int) or isinstance(page_size, bool) or page_size < 1:
        raise ValidationError("page_size must be a positive integer", page_size=page_size)
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise ValidationError("page is 1-based and must be a positive integer", page=page)
    start = (page - 1) * page_size
    return list(entries[start : start + page_size])


def page_count(total: int, page_size: int) -> int:
    """How many pages a board of this size has."""
    if not isinstance(page_size, int) or isinstance(page_size, bool) or page_size < 1:
        raise ValidationError("page_size must be a positive integer", page_size=page_size)
    if total <= 0:
        return 0
    return -(-total // page_size)
