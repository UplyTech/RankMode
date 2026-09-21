"""How a Discord bot wires RankMode in.

This file is deliberately *not* a working bot: it shows the seam. The point of
the library is that it never sees Discord and never sees your database -- the
bot owns both, and hands RankMode nothing but numbers.

The storage layer here is a dictionary so the file runs without a database.
Replace :class:`InMemoryStore` with your own repository and the rest stays.

    python examples/discord_bot_integration.py
"""

from __future__ import annotations

import json
import time

from rankmode import (
    AwardOutcome,
    AwardResult,
    GlobalCap,
    MemberState,
    Multiplier,
    QuadraticCurve,
    RankEngine,
    TieMode,
    build_leaderboard,
    create_event_rule,
    create_member_state,
    deserialize_member_state,
    serialize_member_state,
)

# ---------------------------------------------------------------------------
# The bot's own storage. RankMode never touches this.
# ---------------------------------------------------------------------------


class InMemoryStore:
    """Stand-in for your database.

    A real implementation would be one table:

        CREATE TABLE member_xp (
            guild_id  TEXT NOT NULL,
            member_id TEXT NOT NULL,
            state     JSONB NOT NULL,
            total_xp  BIGINT NOT NULL,   -- denormalised, so the leaderboard
            PRIMARY KEY (guild_id, member_id)   -- can be an ORDER BY + LIMIT
        );

    The denormalised ``total_xp`` column matters: leaderboards should be a
    ``ORDER BY total_xp DESC LIMIT 100`` in the database, not a full scan into
    the bot. RankMode ranks the page you fetched; it does not fetch it.
    """

    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], str] = {}

    def load(self, guild_id: str, member_id: str) -> MemberState:
        raw = self._rows.get((guild_id, member_id))
        if raw is None:
            return create_member_state()
        return deserialize_member_state(json.loads(raw))

    def save(self, guild_id: str, member_id: str, state: MemberState) -> None:
        self._rows[(guild_id, member_id)] = json.dumps(serialize_member_state(state))

    def top(self, guild_id: str, limit: int) -> list[tuple[str, int]]:
        rows = [
            (member_id, deserialize_member_state(json.loads(raw)).total_xp)
            for (guild, member_id), raw in self._rows.items()
            if guild == guild_id
        ]
        rows.sort(key=lambda row: -row[1])
        return rows[:limit]


# ---------------------------------------------------------------------------
# The bot
# ---------------------------------------------------------------------------

#: Roles the operator wants granted at certain levels. RankMode does not know
#: about roles -- deciding and granting them is the bot's job, on purpose.
LEVEL_ROLES = {5: "Regular", 10: "Veteran", 25: "Legend"}

#: Channels that pay less, and roles that pay more. Both are the bot's policy.
CHANNEL_MULTIPLIERS = {"spam": 0, "off-topic": 500}
ROLE_MULTIPLIERS = {"booster": 1250, "staff": 1000}


class LevelBot:
    def __init__(self, store: InMemoryStore) -> None:
        self.store = store
        self.engine = RankEngine(
            curve=QuadraticCurve(base=100, max_level=200),
            rules=[
                create_event_rule("message", 15, 25, cooldown_seconds=60, period_cap_xp=1200),
                create_event_rule("voice_minute", 5, 10, period_cap_xp=1500),
                create_event_rule("reaction", 1, 2, cooldown_seconds=30, period_cap_xp=100),
            ],
            global_cap=GlobalCap(xp=2500, period_seconds=86400),
        )

    # -- the message handler ------------------------------------------------

    def on_message(
        self, guild_id: str, member_id: str, channel: str, roles: list[str]
    ) -> AwardResult:
        """What ``@bot.event async def on_message(message)`` would call."""
        # 1. The bot loads the state from its own database.
        state = self.store.load(guild_id, member_id)

        # 2. The bot decides which multipliers apply. This is policy, and
        #    policy belongs to the bot, not to the library.
        multipliers = self._multipliers_for(channel, roles)

        # 3. RankMode computes. It sees an event type, a timestamp and numbers.
        result = self.engine.award(
            state,
            "message",
            now=int(time.time() * 1000),
            multipliers=multipliers,
        )

        # 4. The bot writes back -- but only when something actually changed.
        #    A blocked cooldown is the common case; skipping the write there
        #    saves the majority of all database round-trips.
        if result.changed:
            self.store.save(guild_id, member_id, result.state)

        # 5. The bot reacts to the level-up. RankMode reported it; acting on it
        #    -- posting a message, granting a role -- is the bot's business.
        if result.leveled_up:
            self._announce_level_up(guild_id, member_id, result)
            role = LEVEL_ROLES.get(result.new_level)
            if role is not None:
                self._grant_role(guild_id, member_id, role)

        return result

    def _multipliers_for(self, channel: str, roles: list[str]) -> list[Multiplier]:
        multipliers = []
        if channel in CHANNEL_MULTIPLIERS:
            multipliers.append(Multiplier(f"channel:{channel}", CHANNEL_MULTIPLIERS[channel]))
        for role in roles:
            if role in ROLE_MULTIPLIERS:
                multipliers.append(Multiplier(f"role:{role}", ROLE_MULTIPLIERS[role]))
        return multipliers

    # -- the /rank command --------------------------------------------------

    def on_rank_command(self, guild_id: str, member_id: str) -> str:
        state = self.store.load(guild_id, member_id)
        progress = self.engine.progress(state.total_xp)

        width = 20
        filled = progress.progress_permille * width // 1000
        bar = "#" * filled + "." * (width - filled)

        if progress.is_max_level:
            tail = "max level reached"
        else:
            tail = f"{progress.xp_to_next} XP to level {progress.level + 1}"

        return (
            f"Level {progress.level}  [{bar}]  "
            f"{progress.progress_permille / 10:.1f}%\n"
            f"{state.total_xp} XP total -- {tail}"
        )

    # -- the /leaderboard command ------------------------------------------

    def on_leaderboard_command(self, guild_id: str, limit: int = 10) -> str:
        # The database does the sorting and the limiting; RankMode does the
        # ranking, which is the part with the tie rules in it.
        rows = self.store.top(guild_id, limit)
        board = build_leaderboard(self.engine.curve, rows, tie_mode=TieMode.COMPETITION)
        return "\n".join(
            f"#{entry.rank:<2} {entry.member_id:<10} "
            f"level {entry.level:<3} {entry.total_xp} XP"
            for entry in board
        )

    # -- the moderation hook ------------------------------------------------

    def on_warning(self, guild_id: str, member_id: str, penalty: int) -> AwardResult:
        state = self.store.load(guild_id, member_id)
        result = self.engine.penalize(
            state,
            penalty,
            now=int(time.time() * 1000),
            # The member should not be able to farm the XP straight back.
            reset_cooldown_for=["message"],
        )
        self.store.save(guild_id, member_id, result.state)

        if result.leveled_down:
            role = LEVEL_ROLES.get(result.previous_level)
            if role is not None:
                self._revoke_role(guild_id, member_id, role)
        return result

    # -- stand-ins for the Discord API -------------------------------------

    def _announce_level_up(self, guild_id: str, member_id: str, result: AwardResult) -> None:
        print(f"   [discord] {member_id} reached level {result.new_level}!")

    def _grant_role(self, guild_id: str, member_id: str, role: str) -> None:
        print(f"   [discord] granted role {role!r} to {member_id}")

    def _revoke_role(self, guild_id: str, member_id: str, role: str) -> None:
        print(f"   [discord] revoked role {role!r} from {member_id}")


def main() -> None:
    bot = LevelBot(InMemoryStore())
    guild = "guild-1"

    print("A few members chat for a while")
    for member in ("ana", "ben", "cai"):
        for _ in range(40):
            # Real traffic would be minutes apart; the cooldown blocks most of
            # these, which is exactly what it is there for.
            bot.on_message(guild, member, channel="general", roles=[])
    # Give them a believable history without waiting an hour for the cooldown.
    for member, total in (("ana", 5200), ("ben", 12_400), ("cai", 5200)):
        state = bot.store.load(guild, member)
        state.total_xp = total
        bot.store.save(guild, member, state)

    print("\n/rank for ana")
    print("   " + bot.on_rank_command(guild, "ana").replace("\n", "\n   "))

    print("\n/leaderboard")
    print("   " + bot.on_leaderboard_command(guild).replace("\n", "\n   "))

    print("\nModeration deducts 3000 XP from ben")
    result = bot.on_warning(guild, "ben", 3000)
    print(
        f"   {result.previous_total_xp} -> {result.new_total_xp} XP, "
        f"level {result.previous_level} -> {result.new_level}"
    )

    print("\nA message in the spam channel is worth nothing")
    outcome = bot.on_message(guild, "dee", channel="spam", roles=[])
    print(f"   outcome: {outcome.outcome.value} (multiplier 0 -> {AwardOutcome.NO_XP.value})")


if __name__ == "__main__":
    main()
