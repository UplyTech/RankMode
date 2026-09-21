"""Converting existing totals when the curve changes.

A curve change moves the level of every member in the community. That is one of
the most disruptive things an operator can do, and it is the reason a curve
change is always a major version. This module makes it survivable: it rewrites
the stored totals so that nobody wakes up two levels lower than they went to
bed.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .curves import Curve
from .errors import MigrationError
from .types import LevelProgress, MigrationResult, MigrationStrategy

__all__ = [
    "migrate_total_xp",
    "migrate_all",
    "preview_migration",
    "MigrationReport",
]


def migrate_total_xp(
    total_xp: int,
    from_curve: Curve,
    to_curve: Curve,
    strategy: MigrationStrategy = MigrationStrategy.PRESERVE_PROGRESS,
) -> MigrationResult:
    """Convert one total from one curve to another."""
    before = from_curve.progress_for_total_xp(total_xp)

    if strategy is MigrationStrategy.PRESERVE_XP:
        after = to_curve.progress_for_total_xp(total_xp)
        return _build(strategy, before, after, False)

    target_level = min(before.level, to_curve.max_level)
    clamped = target_level < before.level
    base = to_curve.total_xp_for_level(target_level)

    if strategy is MigrationStrategy.PRESERVE_LEVEL:
        after = to_curve.progress_for_total_xp(base)
        return _build(strategy, before, after, clamped)

    if strategy is MigrationStrategy.PRESERVE_PROGRESS:
        new_total = base
        if target_level < to_curve.max_level:
            next_threshold = to_curve.total_xp_for_level(target_level + 1)
            span = next_threshold - base
            # Floor, so a member can never be pushed *into* the next level by
            # the migration itself -- a free level is as confusing as a lost one.
            new_total = base + (span * before.progress_permille) // 1000
            # Flooring is not enough on its own. A member sitting at the top of
            # the old curve reports a full bar -- 1000 permille, by convention,
            # because there is no next level to be part-way to -- and carrying a
            # full bar into a curve that *does* have a next level lands them
            # exactly on its threshold. Until 2.0.0 that gave every maxed member
            # a free level the moment an operator extended their curve, which is
            # one of the most ordinary changes there is.
            new_total = min(new_total, next_threshold - 1)
        after = to_curve.progress_for_total_xp(new_total)
        return _build(strategy, before, after, clamped)

    raise MigrationError("Unknown migration strategy", strategy=strategy)


def migrate_all(
    totals: Iterable[int],
    from_curve: Curve,
    to_curve: Curve,
    strategy: MigrationStrategy = MigrationStrategy.PRESERVE_PROGRESS,
) -> list[MigrationResult]:
    """Convert a whole scope at once, keeping the input order.

    The caller can write the new totals back with a single bulk update.
    """
    return [migrate_total_xp(total, from_curve, to_curve, strategy) for total in totals]


@dataclass(frozen=True)
class MigrationReport:
    """What a migration would do to a scope, without changing anything."""

    strategy: MigrationStrategy
    member_count: int
    #: Members whose level number stays the same.
    unchanged: int
    gained_levels: int
    lost_levels: int
    #: Largest number of levels any single member gains.
    max_gain: int
    #: Largest number of levels any single member loses.
    max_loss: int
    #: Sum of all totals before and after -- useful as a sanity check.
    total_xp_before: int
    total_xp_after: int

    @property
    def safe_for_members(self) -> bool:
        """True when no member loses a level. The number an operator asks for."""
        return self.lost_levels == 0


def preview_migration(
    totals: Sequence[int],
    from_curve: Curve,
    to_curve: Curve,
    strategy: MigrationStrategy = MigrationStrategy.PRESERVE_PROGRESS,
) -> MigrationReport:
    """Preview a curve change.

    Run this before switching, put the numbers in front of whoever owns the
    community, and let them decide. The concept is explicit that this step is
    not optional: a curve change without a preview produces complaints.
    """
    results = migrate_all(totals, from_curve, to_curve, strategy)

    unchanged = 0
    gained = 0
    lost = 0
    max_gain = 0
    max_loss = 0
    before_sum = 0
    after_sum = 0

    for result in results:
        before_sum += result.previous_total_xp
        after_sum += result.new_total_xp
        if result.level_delta == 0:
            unchanged += 1
        elif result.level_delta > 0:
            gained += 1
            max_gain = max(max_gain, result.level_delta)
        else:
            lost += 1
            max_loss = max(max_loss, -result.level_delta)

    return MigrationReport(
        strategy=strategy,
        member_count=len(results),
        unchanged=unchanged,
        gained_levels=gained,
        lost_levels=lost,
        max_gain=max_gain,
        max_loss=max_loss,
        total_xp_before=before_sum,
        total_xp_after=after_sum,
    )


def _build(
    strategy: MigrationStrategy,
    before: LevelProgress,
    after: LevelProgress,
    clamped: bool,
) -> MigrationResult:
    return MigrationResult(
        strategy=strategy,
        previous_total_xp=before.total_xp,
        new_total_xp=after.total_xp,
        previous_level=before.level,
        new_level=after.level,
        level_delta=after.level - before.level,
        previous_progress_permille=before.progress_permille,
        new_progress_permille=after.progress_permille,
        clamped_to_curve_top=clamped,
    )
