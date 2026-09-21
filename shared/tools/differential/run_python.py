#!/usr/bin/env python3
"""Answer every generated case with the Python edition.

    PYTHONPATH=python/src python run_python.py --cases cases.json \
        --out results-python.json

This file and ``run-typescript.mjs`` are deliberately written to mirror each
other line for line. A difference between them is a difference in the harness,
not in the library, and it is the one kind of false positive that would make
nobody trust the red build.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from rankmode import (
    Division,
    FixedRandomSource,
    LadderConfig,
    LadderPosition,
    MatchOutcome,
    MigrationStrategy,
    RankEngine,
    RankedConfig,
    RankedEngine,
    Rating,
    RatingSystem,
    ResetPolicy,
    Season,
    SeasonResetConfig,
    SeriesState,
    TieMode,
    Tier,
    apply_league_points,
    apply_multipliers,
    balance_teams,
    build_leaderboard,
    combined_permille,
    create_curve,
    create_event_rule,
    create_member_state,
    create_ranked_state,
    deserialize_member_state,
    expected_score_permille,
    format_position,
    is_acceptable,
    match_quality,
    migrate_total_xp,
    position_for_rating,
    prune_member_state,
    rank_of,
    rating_for_position,
    rating_interval,
    reset_rating,
    serialize_member_state,
    serialize_ranked_state,
    team_rating,
    update_elo,
    update_glicko2,
)
from rankmode.types import DecayRule, GlobalCap, LevelProgress, MemberState, Multiplier

HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# Normalised shapes. Both runners emit exactly these keys, in this order.
# ---------------------------------------------------------------------------
def progress_of(progress: LevelProgress) -> dict[str, Any]:
    return {
        "level": progress.level,
        "totalXp": progress.total_xp,
        "currentThreshold": progress.current_threshold,
        "nextThreshold": progress.next_threshold,
        "xpIntoLevel": progress.xp_into_level,
        "xpToNext": progress.xp_to_next,
        "levelSpan": progress.level_span,
        "progressPermille": progress.progress_permille,
        "progressRatio": progress.progress_ratio,
        "isMaxLevel": progress.is_max_level,
    }


def rating_of(value: Rating) -> dict:
    return {
        "rating": value.rating,
        "deviation": value.deviation,
        "volatility": value.volatility,
        "matchesPlayed": value.matches_played,
    }


def position_of(position: LadderPosition | None) -> dict | None:
    if position is None:
        return None
    return {
        "tier": position.tier.value,
        "division": position.division.value if position.division else None,
        "leaguePoints": position.league_points,
        "series": (
            None
            if position.series is None
            else {
                "winsNeeded": position.series.wins_needed,
                "lossesAllowed": position.series.losses_allowed,
                "wins": position.series.wins,
                "losses": position.series.losses,
            }
        ),
    }


def rating_from(raw: dict) -> Rating:
    return Rating(
        rating=raw["rating"],
        deviation=raw["deviation"],
        volatility=raw["volatility"],
        matches_played=raw["matchesPlayed"],
    )


def ladder_config_from(raw: dict) -> LadderConfig:
    return LadderConfig(
        points_per_division=raw["pointsPerDivision"],
        base_points_gain=raw["basePointsGain"],
        base_points_loss=raw["basePointsLoss"],
        adjustment_span_permille=raw["adjustmentSpanPermille"],
        series_wins_needed=raw["seriesWinsNeeded"],
        series_losses_allowed=raw["seriesLossesAllowed"],
        series_on_tier_promotion=raw["seriesOnTierPromotion"],
        demotion_protection_matches=raw["demotionProtectionMatches"],
        allow_tier_demotion=raw["allowTierDemotion"],
    )


def state_of(state: MemberState) -> dict[str, Any]:
    return {
        "totalXp": state.total_xp,
        "lastEventAt": dict(state.last_event_at),
        "periodStartAt": dict(state.period_start_at),
        "periodAwardedXp": dict(state.period_awarded_xp),
        "lastDecayAt": state.last_decay_at,
    }


def result_of(result: Any) -> dict[str, Any]:
    return {
        "outcome": result.outcome.value,
        "changed": result.changed,
        "awardedXp": result.awarded_xp,
        "baseXp": result.base_xp,
        "multiplierPermille": result.multiplier_permille,
        "previousTotalXp": result.previous_total_xp,
        "newTotalXp": result.new_total_xp,
        "previousLevel": result.previous_level,
        "newLevel": result.new_level,
        "leveledUp": result.leveled_up,
        "leveledDown": result.leveled_down,
        "progress": progress_of(result.progress),
        "ruleEventType": None if result.rule is None else result.rule.event_type,
        "cooldownRemainingMs": result.cooldown_remaining_ms,
        "periodRemainingXp": result.period_remaining_xp,
        "state": state_of(result.state),
    }


def multipliers_of(chain: list[dict[str, Any]]) -> list[Multiplier]:
    return [Multiplier(source=item["source"], permille=item["permille"]) for item in chain]


# ---------------------------------------------------------------------------
# One case, one answer. An error is an answer too: the two editions have to
# agree about what they refuse as well as about what they compute.
# ---------------------------------------------------------------------------
def answer(item: dict[str, Any]) -> dict[str, Any]:  # noqa: C901 - one branch per kind
    kind = item["kind"]

    if kind == "curve":
        curve = create_curve(item["spec"])
        probes = []
        for total_xp in item["probes"]:
            try:
                probes.append(
                    {
                        "totalXp": total_xp,
                        "level": curve.level_for_total_xp(total_xp),
                        "progress": progress_of(curve.progress_for_total_xp(total_xp)),
                    }
                )
            except Exception as error:  # noqa: BLE001 - the class name is the answer
                probes.append({"totalXp": total_xp, "error": type(error).__name__})
        next_levels = []
        for level in (0, 1, curve.max_level):
            try:
                next_levels.append({"level": level, "value": curve.xp_for_next_level(level)})
            except Exception as error:  # noqa: BLE001
                next_levels.append({"level": level, "error": type(error).__name__})
        return {
            "maxLevel": curve.max_level,
            "thresholds": list(curve.thresholds),
            "probes": probes,
            "xpForNextLevel": next_levels,
        }

    if kind == "multipliers":
        chain = multipliers_of(item["chain"])
        return {
            "applied": apply_multipliers(item["baseXp"], chain),
            "combined": combined_permille(chain),
        }

    if kind == "award":
        config = item["config"]
        global_cap = config["globalCap"]
        decay = config["decay"]
        engine = RankEngine(
            curve=create_curve(config["curve"]),
            rules=[
                create_event_rule(
                    event_type=rule["eventType"],
                    min_xp=rule["minXp"],
                    max_xp=rule["maxXp"],
                    cooldown_seconds=rule["cooldownSeconds"],
                    period_cap_xp=rule["periodCapXp"],
                    period_seconds=rule["periodSeconds"],
                    enabled=rule["enabled"],
                )
                for rule in config["rules"]
            ],
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
            allow_negative=config["allowNegative"],
            max_total_xp=config["maxTotalXp"],
        )

        random_source = FixedRandomSource(item["randomValues"], cycle=True)
        state = create_member_state(item["initialTotalXp"])
        steps: list[dict[str, Any]] = []

        for step in item["steps"]:
            op = step["op"]
            try:
                if op == "award":
                    result = engine.award(
                        state,
                        step["eventType"],
                        now=step["now"],
                        multipliers=multipliers_of(step["multipliers"]),
                        random_source=random_source,
                        base_xp=step["baseXp"],
                    )
                    state = result.state
                    steps.append({"op": op, "result": result_of(result)})
                elif op == "penalize":
                    result = engine.penalize(
                        state,
                        step["amount"],
                        now=step["now"],
                        reset_cooldown_for=step["resetCooldownFor"],
                    )
                    state = result.state
                    steps.append({"op": op, "result": result_of(result)})
                elif op == "decay":
                    result = engine.apply_decay(state, now=step["now"])
                    state = result.state
                    steps.append({"op": op, "result": result_of(result)})
                else:
                    state = prune_member_state(
                        state, now=step["now"], keep_cooldown_ms=step["keepCooldownMs"]
                    )
                    steps.append({"op": op, "state": state_of(state)})
            except Exception as error:  # noqa: BLE001
                steps.append({"op": op, "error": type(error).__name__})

        return {"steps": steps, "finalState": state_of(state)}

    if kind == "leaderboard":
        curve = create_curve(item["spec"])
        rows = [(row["memberId"], row["totalXp"]) for row in item["rows"]]
        tie_mode = TieMode(item["tieMode"])
        board = build_leaderboard(
            curve, rows, tie_mode=tie_mode, offset=item["offset"], limit=item["limit"]
        )
        return {
            "entries": [
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
                for entry in board
            ],
            "ranks": [rank_of(row[0], rows, tie_mode=tie_mode) for row in rows],
        }

    if kind == "migration":
        from_curve = create_curve(item["from"])
        to_curve = create_curve(item["to"])
        strategy = MigrationStrategy(item["strategy"])
        results = []
        for total_xp in item["totals"]:
            try:
                result = migrate_total_xp(total_xp, from_curve, to_curve, strategy)
                results.append(
                    {
                        "previousTotalXp": result.previous_total_xp,
                        "newTotalXp": result.new_total_xp,
                        "previousLevel": result.previous_level,
                        "newLevel": result.new_level,
                        "levelDelta": result.level_delta,
                        "previousProgressPermille": result.previous_progress_permille,
                        "newProgressPermille": result.new_progress_permille,
                        "clampedToCurveTop": result.clamped_to_curve_top,
                    }
                )
            except Exception as error:  # noqa: BLE001
                results.append({"totalXp": total_xp, "error": type(error).__name__})
        return {"results": results}

    if kind == "state":
        restored = deserialize_member_state(item["state"])
        pruned = prune_member_state(
            restored, now=item["pruneNow"], keep_cooldown_ms=item["keepCooldownMs"]
        )
        return {"roundTrip": serialize_member_state(restored), "pruned": state_of(pruned)}

    if kind == "rating":
        player = rating_from(item["player"])
        opponent = rating_from(item["opponent"])
        period = [
            (rating_from(entry["opponent"]), MatchOutcome(entry["outcome"]))
            for entry in item["results"]
        ]
        return {
            "expectedElo": expected_score_permille(player, opponent, RatingSystem.ELO),
            "expectedGlicko2": expected_score_permille(player, opponent, RatingSystem.GLICKO2),
            "elo": rating_of(update_elo(player, opponent, MatchOutcome(item["outcome"]))),
            "glicko2Single": rating_of(
                update_glicko2(player, [(opponent, MatchOutcome(item["outcome"]))])
            ),
            "glicko2Period": rating_of(update_glicko2(player, period)),
            "interval": list(rating_interval(player, item["confidencePermille"])),
        }

    if kind == "ladder":
        config = ladder_config_from(item["config"])
        raw = item["from"]
        position = LadderPosition(
            tier=Tier(raw["tier"]),
            division=Division(raw["division"]) if raw["division"] is not None else None,
            league_points=raw["leaguePoints"],
            series=(
                None
                if raw["series"] is None
                else SeriesState(
                    wins_needed=raw["series"]["winsNeeded"],
                    losses_allowed=raw["series"]["lossesAllowed"],
                    wins=raw["series"]["wins"],
                    losses=raw["series"]["losses"],
                )
            ),
        )
        change = apply_league_points(
            position, item["won"], item["rating"], config, item["matchesSincePromotion"]
        )
        return {
            "outcome": change.outcome.value,
            "current": position_of(change.current),
            "pointsDelta": change.points_delta,
            "tierChanged": change.tier_changed,
            "seriesActive": change.series_active,
            "formatted": format_position(change.current),
            "ratingForPosition": rating_for_position(position, config),
            "seeded": [
                position_of(position_for_rating(probe, config)) for probe in item["seedProbes"]
            ],
            "reset": rating_of(
                reset_rating(
                    Rating(
                        rating=item["rating"],
                        deviation=60,
                        volatility=60_000,
                        matches_played=40,
                    ),
                    SeasonResetConfig(
                        policy=ResetPolicy(item["reset"]["policy"]),
                        pull_permille=item["reset"]["pullPermille"],
                        mean_rating=item["reset"]["meanRating"],
                    ),
                )
            ),
        }

    if kind == "ranked":
        engine = RankedEngine(
            RankedConfig(
                system=RatingSystem(item["system"]),
                season=(
                    Season(id="S1", name="One", starts_at=0, ends_at=10_000_000_000)
                    if item["withSeason"]
                    else None
                ),
                placement_matches=item["placementMatches"],
                streak_threshold=item["streakThreshold"],
                streak_bonus_points=item["streakBonusPoints"],
                max_streak_bonus=item["maxStreakBonus"],
            )
        )
        state = create_ranked_state(rating_from(item["start"]))
        steps = []
        for index, match in enumerate(item["matches"]):
            result = engine.record_match(
                state,
                rating_from(match["opponent"]),
                MatchOutcome(match["outcome"]),
                index * 60_000,
            )
            state = result.state
            steps.append(
                {
                    "ratingDelta": result.rating_delta,
                    "inPlacements": result.in_placements,
                    "placementsRemaining": result.placements_remaining,
                    "expectedPermille": result.expected_permille,
                    "streak": result.streak,
                    "ladder": (
                        None
                        if result.ladder is None
                        else {
                            "outcome": result.ladder.outcome.value,
                            "pointsDelta": result.ladder.points_delta,
                        }
                    ),
                }
            )
        summary = engine.summarise(state)
        return {
            "steps": steps,
            "finalState": serialize_ranked_state(state),
            "summary": {
                "seasonId": summary.season_id,
                "matchesPlayed": summary.matches_played,
                "wins": summary.wins,
                "losses": summary.losses,
                "draws": summary.draws,
                "peakRating": summary.peak_rating,
                "finalRating": summary.final_rating,
                "peakPosition": position_of(summary.peak_position),
                "finalPosition": position_of(summary.final_position),
            },
        }

    if kind == "matchmaking":
        left = rating_from(item["left"])
        right = rating_from(item["right"])
        system = RatingSystem(item["system"])
        quality = match_quality(left, right, system)
        reversed_quality = match_quality(right, left, system)
        players = [rating_from(player) for player in item["players"]]
        split = balance_teams(players, system)
        return {
            "qualityPermille": quality.quality_permille,
            "winProbabilityPermille": quality.win_probability_permille,
            "ratingGap": quality.rating_gap,
            "confident": quality.confident,
            # The reversed call is answered too: it is the property that used to
            # fail, and a harness that only asked one way round would not see it.
            "reversedQualityPermille": reversed_quality.quality_permille,
            "acceptable": is_acceptable(
                quality, item["minimumQualityPermille"], item["maximumGap"]
            ),
            "team": rating_of(team_rating(players)),
            "left": list(split.left),
            "right": list(split.right),
            "splitQualityPermille": split.quality.quality_permille,
        }

    raise ValueError(f"unknown case kind: {kind}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default=str(HERE / "cases.json"))
    parser.add_argument("--out", default=str(HERE / "results-python.json"))
    args = parser.parse_args()

    payload = json.loads(Path(args.cases).read_text(encoding="utf-8"))

    results = []
    for item in payload["cases"]:
        try:
            results.append({"id": item["id"], "kind": item["kind"], "value": answer(item)})
        except Exception as error:  # noqa: BLE001
            results.append({"id": item["id"], "kind": item["kind"], "error": type(error).__name__})

    Path(args.out).write_text(
        json.dumps(
            {
                "formatVersion": payload["formatVersion"],
                "seed": payload["seed"],
                "edition": "python",
                "results": results,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"python answered {len(results)} cases -> {args.out}")


if __name__ == "__main__":
    main()
