"""The five things almost every caller needs, in one runnable file.

python examples/basic.py
"""

from __future__ import annotations

import json

from rankmode import (
    AwardOutcome,
    DecayRule,
    GlobalCap,
    Multiplier,
    QuadraticCurve,
    RankEngine,
    TieMode,
    build_leaderboard,
    create_event_rule,
    create_member_state,
    deserialize_member_state,
    rank_of,
    serialize_member_state,
)

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS
NOW = 1_700_000_000_000


def main() -> None:
    # ---------------------------------------------------------------- setup
    engine = RankEngine(
        curve=QuadraticCurve(base=100, max_level=100),
        rules=[
            create_event_rule("message", 15, 25, cooldown_seconds=60, period_cap_xp=1000),
            create_event_rule("voice_minute", 5, 10, period_cap_xp=1500),
            create_event_rule("reaction", 1, 2, cooldown_seconds=30, period_cap_xp=100),
        ],
        global_cap=GlobalCap(xp=2000, period_seconds=86400),
        decay=DecayRule(
            xp_per_period=25, period_seconds=DAY_MS // 1000, grace_seconds=30 * 86400
        ),
    )

    # ------------------------------------------------------- 1. award XP
    print("1. A member writes a message")
    state = create_member_state()
    result = engine.award(state, "message", now=NOW)
    print(f"   {result.outcome.value}: +{result.awarded_xp} XP -> {result.new_total_xp}")
    state = result.state  # the caller stores this

    # ------------------------------------------ 2. the cooldown protects us
    print("\n2. The same member writes again, ten seconds later")
    blocked = engine.award(state, "message", now=NOW + 10_000)
    print(
        f"   {blocked.outcome.value}: "
        f"{blocked.cooldown_remaining_ms // 1000}s left, nothing awarded"
    )

    # ------------------------------------------------- 3. a level-up moment
    print("\n3. Fast-forward: the member is one message short of level 3")
    almost = create_member_state(engine.curve.total_xp_for_level(3) - 10)
    levelled = engine.award(almost, "message", now=NOW, base_xp=20)
    if levelled.leveled_up:
        print(f"   Level up! {levelled.previous_level} -> {levelled.new_level}")
        print("   (this is where your bot posts the message and grants the role)")

    # ------------------------------------------- 4. the level card numbers
    print("\n4. The numbers a level card needs")
    progress = engine.progress(levelled.new_total_xp)
    bar_width = 20
    filled = progress.progress_permille * bar_width // 1000
    print(f"   Level {progress.level}  [{'#' * filled}{'.' * (bar_width - filled)}]")
    print(f"   {progress.xp_into_level} / {progress.level_span} XP into this level")
    print(f"   {progress.xp_to_next} XP to level {progress.level + 1}")

    # --------------------------------------------- 5. a promotion weekend
    print("\n5. Double XP weekend")
    doubled = engine.award(
        create_member_state(),
        "message",
        now=NOW,
        base_xp=20,
        multipliers=[Multiplier("double-xp-weekend", 2000)],
    )
    print(f"   base {doubled.base_xp} XP -> awarded {doubled.awarded_xp} XP")

    # ------------------------------------------------------ 6. leaderboard
    print("\n6. Leaderboard with a tie")
    rows = [("ana", 5000), ("ben", 12_000), ("cai", 5000), ("dee", 800)]
    for entry in build_leaderboard(engine.curve, rows, tie_mode=TieMode.COMPETITION):
        print(
            f"   #{entry.rank:<2} {entry.member_id:<4} level {entry.level:<3} {entry.total_xp} XP"
        )
    print(f"   ana alone would ask: rank {rank_of('ana', rows)}")

    # ------------------------------------------------------ 7. persistence
    print("\n7. Storing and reloading the state")
    stored = json.dumps(serialize_member_state(state))
    print(f"   stored: {stored}")
    reloaded = deserialize_member_state(json.loads(stored))
    print(f"   reloaded total: {reloaded.total_xp}")

    # ----------------------------------------------------------- 8. decay
    print("\n8. Decay after two months of silence")
    idle = create_member_state(3000)
    idle.last_event_at["message"] = NOW
    decayed = engine.apply_decay(idle, now=NOW + 60 * DAY_MS)
    if decayed.outcome is AwardOutcome.DECAYED:
        print(f"   {decayed.awarded_xp} XP -> {decayed.new_total_xp}")


if __name__ == "__main__":
    main()
