"""The contract between the two editions, for the ranked half.

Same rule as ``test_shared_vectors.py``: these numbers are generated from the
TypeScript edition and this one must reproduce every last one of them. A
difference here is not a failing test, it is two communities where the same
player is Gold in one client and Silver in the other.

The engine vectors are the valuable ones. Every other case is a single call
with a single answer, and a divergence in one would show up in the first
release. The engine cases replay a whole season match by match, and they are the
only thing in the suite that catches a divergence which needs a hundred updates
of accumulated state before it appears.

Regenerating is a deliberate act: if a vector changes, the behaviour changed,
and that belongs in the changelog with a version bump. Never regenerate to make
a failing test pass.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from rankmode import (
    Division,
    LadderConfig,
    LadderPosition,
    MatchOutcome,
    RankedConfig,
    RankedEngine,
    Rating,
    RatingSystem,
    ResetPolicy,
    Season,
    SeasonResetConfig,
    SeriesState,
    Tier,
    apply_league_points,
    balance_teams,
    create_ranked_state,
    create_rating,
    expected_score_permille,
    format_position,
    match_quality,
    position_for_rating,
    rating_for_position,
    rating_interval,
    reset_rating,
    serialize_ranked_state,
    team_rating,
    update_elo,
    update_glicko2,
)

VECTOR_FILE = Path(__file__).resolve().parents[2] / "shared" / "testcases" / "ranked.json"

SUPPORTED_FORMAT_VERSION = 1


@pytest.fixture(scope="module")
def vectors() -> dict[str, Any]:
    assert VECTOR_FILE.is_file(), f"shared ranked vectors missing at {VECTOR_FILE}"
    data: dict[str, Any] = json.loads(VECTOR_FILE.read_text(encoding="utf-8"))
    assert data["formatVersion"] == SUPPORTED_FORMAT_VERSION
    return data


def rating_from(raw: dict[str, Any]) -> Rating:
    return create_rating(
        rating=raw["rating"],
        deviation=raw["deviation"],
        volatility=raw.get("volatility", 60_000),
        matches_played=raw.get("matchesPlayed", 0),
    )


def position_from(raw: dict[str, Any] | None) -> LadderPosition | None:
    if raw is None:
        return None
    series_raw = raw.get("series")
    return LadderPosition(
        tier=Tier(raw["tier"]),
        division=Division(raw["division"]) if raw.get("division") is not None else None,
        league_points=raw["leaguePoints"],
        series=(
            None
            if series_raw is None
            else SeriesState(
                wins_needed=series_raw["winsNeeded"],
                losses_allowed=series_raw["lossesAllowed"],
                wins=series_raw["wins"],
                losses=series_raw["losses"],
            )
        ),
    )


def test_the_vector_file_is_present(vectors: dict[str, Any]) -> None:
    for group in (
        "expected",
        "elo",
        "glicko2",
        "intervals",
        "seeding",
        "ladder",
        "series",
        "seasonResets",
        "matchmaking",
        "teams",
        "balance",
        "engine",
    ):
        assert vectors[group], f"the {group} vectors are empty"


def test_expected_scores(vectors: dict[str, Any]) -> None:
    for case in vectors["expected"]:
        player = rating_from(case["player"])
        opponent = rating_from(case["opponent"])
        assert (
            expected_score_permille(player, opponent, RatingSystem.ELO) == case["expectedElo"]
        ), case
        assert (
            expected_score_permille(player, opponent, RatingSystem.GLICKO2)
            == case["expectedGlicko2"]
        ), case


def test_elo_updates(vectors: dict[str, Any]) -> None:
    for case in vectors["elo"]:
        got = update_elo(
            rating_from(case["player"]),
            rating_from(case["opponent"]),
            MatchOutcome(case["outcome"]),
        )
        assert got == rating_from(case["result"]), case


def test_glicko2_updates(vectors: dict[str, Any]) -> None:
    for case in vectors["glicko2"]:
        results = [
            (rating_from(entry["opponent"]), MatchOutcome(entry["outcome"]))
            for entry in case["results"]
        ]
        got = update_glicko2(rating_from(case["player"]), results)
        assert got == rating_from(case["result"]), case.get("id", case)


def test_rating_intervals(vectors: dict[str, Any]) -> None:
    for case in vectors["intervals"]:
        low, high = rating_interval(
            create_rating(rating=1500, deviation=case["deviation"]),
            case["confidencePermille"],
        )
        assert (low, high) == (case["low"], case["high"]), case


def test_ladder_seeding(vectors: dict[str, Any]) -> None:
    ladder = LadderConfig()
    for case in vectors["seeding"]:
        position = position_for_rating(case["rating"], ladder)
        assert position.tier.value == case["tier"], case
        assert (position.division.value if position.division else None) == case["division"], (
            case
        )
        assert position.league_points == case["leaguePoints"], case
        assert format_position(position) == case["formatted"], case
        assert rating_for_position(position, ladder) == case["roundTripRating"], case


def test_ladder_transitions(vectors: dict[str, Any]) -> None:
    ladder = LadderConfig()
    for case in vectors["ladder"]:
        start = position_from(case["from"])
        assert start is not None
        change = apply_league_points(
            start,
            case["won"],
            case["rating"],
            ladder,
            case["matchesSincePromotion"],
        )
        assert change.outcome.value == case["outcome"], case
        assert change.current == position_from(case["to"]), case
        assert change.points_delta == case["pointsDelta"], case
        assert change.tier_changed == case["tierChanged"], case
        assert change.series_active == case["seriesActive"], case


def test_promotion_series(vectors: dict[str, Any]) -> None:
    ladder = LadderConfig()
    for case in vectors["series"]:
        position = LadderPosition(
            tier=Tier.GOLD,
            division=Division.ONE,
            league_points=100,
            series=SeriesState(
                wins_needed=3,
                losses_allowed=2,
                wins=case["series"]["wins"],
                losses=case["series"]["losses"],
            ),
        )
        change = apply_league_points(position, case["won"], 1500, ladder, 999)
        expected = case["to"]
        assert change.outcome.value == case["outcome"], case
        assert change.current.tier.value == expected["tier"], case
        assert (
            change.current.division.value if change.current.division else None
        ) == expected["division"], case
        assert change.current.league_points == expected["leaguePoints"], case
        if expected["series"] is None:
            assert change.current.series is None, case
        else:
            assert change.current.series is not None
            assert change.current.series.wins == expected["series"]["wins"], case
            assert change.current.series.losses == expected["series"]["losses"], case


def test_season_resets(vectors: dict[str, Any]) -> None:
    for case in vectors["seasonResets"]:
        got = reset_rating(
            rating_from(case["from"]),
            SeasonResetConfig(
                policy=ResetPolicy(case["policy"]), pull_permille=case["pullPermille"]
            ),
        )
        assert got == rating_from(case["to"]), case


def test_match_quality(vectors: dict[str, Any]) -> None:
    for case in vectors["matchmaking"]:
        quality = match_quality(
            rating_from(case["left"]),
            rating_from(case["right"]),
            RatingSystem(case["system"]),
        )
        assert quality.quality_permille == case["qualityPermille"], case
        assert quality.win_probability_permille == case["winProbabilityPermille"], case
        assert quality.rating_gap == case["ratingGap"], case
        assert quality.confident == case["confident"], case


def test_team_ratings(vectors: dict[str, Any]) -> None:
    for case in vectors["teams"]:
        got = team_rating([rating_from(member) for member in case["members"]])
        assert got == rating_from(case["result"]), case


def test_team_balancing(vectors: dict[str, Any]) -> None:
    for case in vectors["balance"]:
        split = balance_teams([rating_from(player) for player in case["players"]])
        assert list(split.left) == case["left"], case
        assert list(split.right) == case["right"], case
        assert split.quality.quality_permille == case["qualityPermille"], case


def test_whole_seasons_replay_identically(vectors: dict[str, Any]) -> None:
    """The vector that matters most.

    Every other case in this file is one call with one answer. These replay a
    hundred and twenty matches through the engine, carrying the state forward,
    which is the only way a divergence that needs accumulated state to appear
    ever shows up before a release.
    """
    for run in vectors["engine"]:
        config = run["config"]
        season = Season(
            id=config["seasonId"], name="Season One", starts_at=0, ends_at=10_000_000
        )
        engine = RankedEngine(
            RankedConfig(
                system=RatingSystem(config["system"]),
                season=season,
                streak_threshold=config["streakThreshold"],
                placement_matches=config["placementMatches"],
            )
        )
        state = create_ranked_state()

        for index, match in enumerate(run["matches"]):
            result = engine.record_match(
                state,
                rating_from(match["opponent"]),
                MatchOutcome(match["outcome"]),
                match["now"],
            )
            state = result.state
            where = f"{run['id']} match {index}"

            assert result.rating_delta == match["ratingDelta"], where
            assert result.in_placements == match["inPlacements"], where
            assert result.placements_remaining == match["placementsRemaining"], where
            assert result.expected_permille == match["expectedPermille"], where
            assert result.streak == match["streak"], where
            assert state.rating.rating == match["rating"], where
            assert state.rating.deviation == match["deviation"], where
            assert state.rating.volatility == match["volatility"], where

            if match["position"] is None:
                assert state.position is None, where
            else:
                assert state.position is not None, where
                assert state.position.tier.value == match["position"]["tier"], where
                assert (
                    state.position.division.value if state.position.division else None
                ) == match["position"]["division"], where
                assert state.position.league_points == match["position"]["leaguePoints"], where

            if match["ladder"] is None:
                assert result.ladder is None, where
            else:
                assert result.ladder is not None, where
                assert result.ladder.outcome.value == match["ladder"]["outcome"], where
                assert result.ladder.points_delta == match["ladder"]["pointsDelta"], where

            if match["state"] is not None:
                assert serialize_ranked_state(state) == match["state"], where

        summary = engine.summarise(state)
        expected = run["summary"]
        assert summary.season_id == expected["seasonId"], run["id"]
        assert summary.matches_played == expected["matchesPlayed"], run["id"]
        assert summary.wins == expected["wins"], run["id"]
        assert summary.losses == expected["losses"], run["id"]
        assert summary.draws == expected["draws"], run["id"]
        assert summary.peak_rating == expected["peakRating"], run["id"]
        assert summary.final_rating == expected["finalRating"], run["id"]
        assert serialize_ranked_state(state) == run["finalState"], run["id"]
