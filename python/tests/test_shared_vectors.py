"""The contract between the Python and the TypeScript edition.

Both editions run this same set of cases. A difference in either one turns into
a red build here rather than into two communities whose members hold different
levels for the same activity -- the failure mode the concept calls out as worse
than having four separate implementations, because nobody expects it.

The vectors live in ``../../shared/testcases`` and are generated from the
TypeScript edition by ``typescript/scripts/generate-shared-vectors.mjs``.
Regenerating them is a deliberate act: if a vector changes, the behaviour of
the library changed, and that belongs in the changelog with a version bump.
Never regenerate to make a failing test pass.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from rankmode import (
    AwardResult,
    DecayRule,
    EventRule,
    FixedRandomSource,
    GlobalCap,
    MigrationStrategy,
    Multiplier,
    RankEngine,
    SeededRandomSource,
    TieMode,
    apply_multipliers,
    build_leaderboard,
    create_curve,
    create_event_rule,
    create_member_state,
    migrate_total_xp,
    rank_of,
)

VECTOR_DIR = Path(__file__).resolve().parents[2] / "shared" / "testcases"

SUPPORTED_FORMAT_VERSION = 1


def load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (VECTOR_DIR / f"{name}.json").read_text(encoding="utf-8")
    )
    return data


def rule_from_vector(raw: dict[str, Any]) -> EventRule:
    """Build an EventRule from the JSON (camelCase) spelling."""
    return create_event_rule(
        event_type=raw["eventType"],
        min_xp=raw["minXp"],
        max_xp=raw.get("maxXp"),
        cooldown_seconds=raw.get("cooldownSeconds", 0),
        period_cap_xp=raw.get("periodCapXp"),
        period_seconds=raw.get("periodSeconds", 86400),
        enabled=raw.get("enabled", True),
    )


def test_vector_directory_is_present() -> None:
    assert VECTOR_DIR.is_dir(), f"shared test vectors missing at {VECTOR_DIR}"


# ---------------------------------------------------------------------------
# curves
# ---------------------------------------------------------------------------

CURVES = load("curves")


def test_curves_use_a_known_format_version() -> None:
    assert CURVES["formatVersion"] == SUPPORTED_FORMAT_VERSION


@pytest.mark.parametrize("entry", CURVES["curves"], ids=lambda e: e["id"])
def test_curve_threshold_table(entry: dict[str, Any]) -> None:
    curve = create_curve(entry["spec"])
    assert curve.max_level == entry["maxLevel"]
    assert list(curve.thresholds) == entry["thresholds"]


@pytest.mark.parametrize("entry", CURVES["curves"], ids=lambda e: e["id"])
def test_curve_progress_probes(entry: dict[str, Any]) -> None:
    curve = create_curve(entry["spec"])
    for probe in entry["probes"]:
        progress = curve.progress_for_total_xp(probe["totalXp"])
        assert {
            "totalXp": progress.total_xp,
            "level": progress.level,
            "currentThreshold": progress.current_threshold,
            "nextThreshold": progress.next_threshold,
            "xpIntoLevel": progress.xp_into_level,
            "xpToNext": progress.xp_to_next,
            "levelSpan": progress.level_span,
            "progressPermille": progress.progress_permille,
            "isMaxLevel": progress.is_max_level,
        } == probe


# ---------------------------------------------------------------------------
# multipliers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", load("multipliers")["cases"])
def test_multiplier_chain(case: dict[str, Any]) -> None:
    chain = [
        Multiplier(f"m{index}", permille) for index, permille in enumerate(case["permilles"])
    ]
    assert apply_multipliers(case["baseXp"], chain) == case["expected"]


# ---------------------------------------------------------------------------
# seeded random source
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("entry", load("random")["seeds"], ids=lambda e: str(e["seed"]))
def test_seeded_random_stream(entry: dict[str, Any]) -> None:
    raw = SeededRandomSource(entry["seed"])
    assert [raw.next_32() for _ in entry["next32"]] == entry["next32"]

    span = SeededRandomSource(entry["seed"])
    assert [span.random_int(15, 25) for _ in entry["randomInt15to25"]] == entry[
        "randomInt15to25"
    ]


# ---------------------------------------------------------------------------
# awards
# ---------------------------------------------------------------------------

AWARDS = load("awards")


@pytest.mark.parametrize("scenario", AWARDS["scenarios"], ids=lambda s: s["id"])
def test_award_scenario(scenario: dict[str, Any]) -> None:
    config = scenario["config"]
    global_cap = config.get("globalCap")
    decay = config.get("decay")

    engine = RankEngine(
        curve=create_curve(config["curve"]),
        rules=[rule_from_vector(rule) for rule in config.get("rules", [])],
        global_cap=(
            None
            if global_cap is None
            else GlobalCap(xp=global_cap["xp"], period_seconds=global_cap["periodSeconds"])
        ),
        decay=(
            None
            if decay is None
            else DecayRule(
                xp_per_period=decay["xpPerPeriod"],
                period_seconds=decay["periodSeconds"],
                floor_xp=decay["floorXp"],
                grace_seconds=decay["graceSeconds"],
            )
        ),
        allow_negative=config.get("allowNegative", False),
    )

    random_source = FixedRandomSource(scenario["randomValues"])
    state = create_member_state(scenario["initialTotalXp"])

    for index, step in enumerate(scenario["steps"]):
        now = AWARDS["baseTimestampMs"] + step["nowOffsetMs"]
        kind = step.get("kind")

        result: AwardResult
        if kind == "penalize":
            result = engine.penalize(state, step["amount"], now=now)
        elif kind == "decay":
            result = engine.apply_decay(state, now=now)
        else:
            result = engine.award(
                state,
                step["eventType"],
                now=now,
                random_source=random_source,
                multipliers=[
                    Multiplier(m["source"], m["permille"]) for m in step.get("multipliers", [])
                ],
            )
        state = result.state

        actual = {
            "outcome": result.outcome.value,
            "awardedXp": result.awarded_xp,
            "baseXp": result.base_xp,
            "multiplierPermille": result.multiplier_permille,
            "previousTotalXp": result.previous_total_xp,
            "newTotalXp": result.new_total_xp,
            "previousLevel": result.previous_level,
            "newLevel": result.new_level,
            "leveledUp": result.leveled_up,
            "leveledDown": result.leveled_down,
            "progressPermille": result.progress.progress_permille,
            "cooldownRemainingMs": result.cooldown_remaining_ms,
            "periodRemainingXp": result.period_remaining_xp,
        }
        assert actual == step["expected"], f"step {index} of {scenario['id']}"

    assert state.total_xp == scenario["finalTotalXp"]


# ---------------------------------------------------------------------------
# leaderboard
# ---------------------------------------------------------------------------

BOARD = load("leaderboard")
BOARD_ROWS = [(row["memberId"], row["totalXp"]) for row in BOARD["rows"]]
BOARD_CURVE = create_curve(BOARD["curve"])


@pytest.mark.parametrize("board", BOARD["boards"], ids=lambda b: b["tieMode"])
def test_leaderboard_board(board: dict[str, Any]) -> None:
    built = build_leaderboard(BOARD_CURVE, BOARD_ROWS, tie_mode=TieMode(board["tieMode"]))
    assert [
        {
            "memberId": entry.member_id,
            "totalXp": entry.total_xp,
            "level": entry.level,
            "rank": entry.rank,
            "competitionRank": entry.competition_rank,
            "denseRank": entry.dense_rank,
            "position": entry.position,
            "progressPermille": entry.progress.progress_permille,
        }
        for entry in built
    ] == board["entries"]


@pytest.mark.parametrize("board", BOARD["boards"], ids=lambda b: b["tieMode"])
def test_leaderboard_single_member_rank(board: dict[str, Any]) -> None:
    for member_id, expected in board["rankOf"].items():
        assert rank_of(member_id, BOARD_ROWS, tie_mode=TieMode(board["tieMode"])) == expected


def test_leaderboard_paging() -> None:
    built = build_leaderboard(
        BOARD_CURVE,
        BOARD_ROWS,
        offset=BOARD["paging"]["offset"],
        limit=BOARD["paging"]["limit"],
    )
    assert [entry.member_id for entry in built] == BOARD["paging"]["memberIds"]


# ---------------------------------------------------------------------------
# migration
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", load("migration")["cases"], ids=lambda c: c["id"])
def test_migration_case(case: dict[str, Any]) -> None:
    from_curve = create_curve(case["from"])
    to_curve = create_curve(case["to"])
    strategy = MigrationStrategy(case["strategy"])

    for expected in case["results"]:
        result = migrate_total_xp(expected["previousTotalXp"], from_curve, to_curve, strategy)
        assert {
            "previousTotalXp": result.previous_total_xp,
            "newTotalXp": result.new_total_xp,
            "previousLevel": result.previous_level,
            "newLevel": result.new_level,
            "levelDelta": result.level_delta,
            "previousProgressPermille": result.previous_progress_permille,
            "newProgressPermille": result.new_progress_permille,
            "clampedToCurveTop": result.clamped_to_curve_top,
        } == expected
