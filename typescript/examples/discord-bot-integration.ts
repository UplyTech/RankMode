/**
 * How a Discord bot wires RankMode in.
 *
 *   npx vite-node examples/discord-bot-integration.ts
 *
 * This file is deliberately *not* a working bot: it shows the seam. The point
 * of the library is that it never sees Discord and never sees your database --
 * the bot owns both, and hands RankMode nothing but numbers.
 *
 * The storage layer here is a Map so the file runs without a database.
 * Replace `InMemoryStore` with your own repository and the rest stays.
 */
import {
  AwardOutcome,
  buildLeaderboard,
  createEventRule,
  createMemberState,
  deserializeMemberState,
  QuadraticCurve,
  RankEngine,
  serializeMemberState,
  TieMode,
  type AwardResult,
  type MemberState,
  type Multiplier,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// The bot's own storage. RankMode never touches this.
// ---------------------------------------------------------------------------

/**
 * Stand-in for your database. A real implementation would be one table:
 *
 * ```sql
 * CREATE TABLE member_xp (
 *   guild_id  TEXT   NOT NULL,
 *   member_id TEXT   NOT NULL,
 *   state     JSONB  NOT NULL,
 *   total_xp  BIGINT NOT NULL,        -- denormalised, so the leaderboard
 *   PRIMARY KEY (guild_id, member_id) -- can be an ORDER BY + LIMIT
 * );
 * ```
 *
 * That denormalised `total_xp` column matters: leaderboards should be an
 * `ORDER BY total_xp DESC LIMIT 100` in the database, not a full scan into the
 * bot. RankMode ranks the page you fetched; it does not fetch it.
 */
class InMemoryStore {
  private readonly rows = new Map<string, string>();

  private key(guildId: string, memberId: string): string {
    return `${guildId}:${memberId}`;
  }

  public load(guildId: string, memberId: string): MemberState {
    const raw = this.rows.get(this.key(guildId, memberId));
    return raw === undefined
      ? createMemberState()
      : deserializeMemberState(JSON.parse(raw));
  }

  public save(guildId: string, memberId: string, state: MemberState): void {
    this.rows.set(this.key(guildId, memberId), JSON.stringify(serializeMemberState(state)));
  }

  public top(guildId: string, limit: number): { memberId: string; totalXp: number }[] {
    const result: { memberId: string; totalXp: number }[] = [];
    for (const [key, raw] of this.rows) {
      const [guild, memberId] = key.split(":");
      if (guild === guildId && memberId !== undefined) {
        result.push({ memberId, totalXp: deserializeMemberState(JSON.parse(raw)).totalXp });
      }
    }
    result.sort((a, b) => b.totalXp - a.totalXp);
    return result.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

/**
 * Roles the operator wants granted at certain levels. RankMode does not know
 * about roles -- deciding and granting them is the bot's job, on purpose.
 */
const LEVEL_ROLES: Record<number, string> = { 5: "Regular", 10: "Veteran", 25: "Legend" };

/** Channels that pay less, and roles that pay more. Both are the bot's policy. */
const CHANNEL_MULTIPLIERS: Record<string, number> = { spam: 0, "off-topic": 500 };
const ROLE_MULTIPLIERS: Record<string, number> = { booster: 1250, staff: 1000 };

class LevelBot {
  private readonly engine = new RankEngine({
    curve: new QuadraticCurve({ base: 100, maxLevel: 200 }),
    rules: [
      createEventRule({
        eventType: "message",
        minXp: 15,
        maxXp: 25,
        cooldownSeconds: 60,
        periodCapXp: 1200,
      }),
      createEventRule({ eventType: "voice_minute", minXp: 5, maxXp: 10, periodCapXp: 1500 }),
      createEventRule({
        eventType: "reaction",
        minXp: 1,
        maxXp: 2,
        cooldownSeconds: 30,
        periodCapXp: 100,
      }),
    ],
    globalCap: { xp: 2500, periodSeconds: 86400 },
  });

  constructor(private readonly store: InMemoryStore) {}

  /** What `client.on("messageCreate", ...)` would call. */
  public onMessage(
    guildId: string,
    memberId: string,
    channel: string,
    roles: readonly string[],
  ): AwardResult {
    // 1. The bot loads the state from its own database.
    const state = this.store.load(guildId, memberId);

    // 2. The bot decides which multipliers apply. This is policy, and policy
    //    belongs to the bot, not to the library.
    const multipliers = this.multipliersFor(channel, roles);

    // 3. RankMode computes. It sees an event type, a timestamp and numbers.
    const result = this.engine.award(state, "message", {
      now: Date.now(),
      multipliers,
    });

    // 4. The bot writes back -- but only when something actually changed. A
    //    blocked cooldown is the common case; skipping the write there saves
    //    the majority of all database round-trips.
    if (result.awardedXp !== 0) {
      this.store.save(guildId, memberId, result.state);
    }

    // 5. The bot reacts to the level-up. RankMode reported it; acting on it --
    //    posting a message, granting a role -- is the bot's business.
    if (result.leveledUp) {
      this.announceLevelUp(memberId, result);
      const role = LEVEL_ROLES[result.newLevel];
      if (role !== undefined) {
        this.grantRole(memberId, role);
      }
    }

    return result;
  }

  private multipliersFor(channel: string, roles: readonly string[]): Multiplier[] {
    const multipliers: Multiplier[] = [];
    const channelFactor = CHANNEL_MULTIPLIERS[channel];
    if (channelFactor !== undefined) {
      multipliers.push({ source: `channel:${channel}`, permille: channelFactor });
    }
    for (const role of roles) {
      const roleFactor = ROLE_MULTIPLIERS[role];
      if (roleFactor !== undefined) {
        multipliers.push({ source: `role:${role}`, permille: roleFactor });
      }
    }
    return multipliers;
  }

  /** The `/rank` command. */
  public onRankCommand(guildId: string, memberId: string): string {
    const state = this.store.load(guildId, memberId);
    const progress = this.engine.progress(state.totalXp);

    const width = 20;
    const filled = Math.floor((progress.progressPermille * width) / 1000);
    const bar = "#".repeat(filled) + ".".repeat(width - filled);
    const tail = progress.isMaxLevel
      ? "max level reached"
      : `${progress.xpToNext} XP to level ${progress.level + 1}`;

    return (
      `Level ${progress.level}  [${bar}]  ${(progress.progressPermille / 10).toFixed(1)}%\n` +
      `${state.totalXp} XP total -- ${tail}`
    );
  }

  /** The `/leaderboard` command. */
  public onLeaderboardCommand(guildId: string, limit = 10): string {
    // The database does the sorting and the limiting; RankMode does the
    // ranking, which is the part with the tie rules in it.
    const rows = this.store.top(guildId, limit);
    return buildLeaderboard(this.engine.curve, rows, { tieMode: TieMode.Competition })
      .map(
        (entry) =>
          `#${String(entry.rank).padEnd(2)} ${entry.memberId.padEnd(10)} ` +
          `level ${String(entry.level).padEnd(3)} ${entry.totalXp} XP`,
      )
      .join("\n");
  }

  /** The moderation hook. */
  public onWarning(guildId: string, memberId: string, penalty: number): AwardResult {
    const state = this.store.load(guildId, memberId);
    const result = this.engine.penalize(state, penalty, {
      now: Date.now(),
      // The member should not be able to farm the XP straight back.
      resetCooldownFor: ["message"],
    });
    this.store.save(guildId, memberId, result.state);

    if (result.leveledDown) {
      const role = LEVEL_ROLES[result.previousLevel];
      if (role !== undefined) {
        this.revokeRole(memberId, role);
      }
    }
    return result;
  }

  // -- stand-ins for the Discord API ---------------------------------------

  private announceLevelUp(memberId: string, result: AwardResult): void {
    console.log(`   [discord] ${memberId} reached level ${result.newLevel}!`);
  }

  private grantRole(memberId: string, role: string): void {
    console.log(`   [discord] granted role "${role}" to ${memberId}`);
  }

  private revokeRole(memberId: string, role: string): void {
    console.log(`   [discord] revoked role "${role}" from ${memberId}`);
  }
}

// ---------------------------------------------------------------------------
// A short run
// ---------------------------------------------------------------------------

const store = new InMemoryStore();
const bot = new LevelBot(store);
const guild = "guild-1";

console.log("A few members chat for a while");
for (const member of ["ana", "ben", "cai"]) {
  for (let i = 0; i < 40; i += 1) {
    // Real traffic would be minutes apart; the cooldown blocks most of these,
    // which is exactly what it is there for.
    bot.onMessage(guild, member, "general", []);
  }
}
// Give them a believable history without waiting an hour for the cooldown.
for (const [member, total] of [
  ["ana", 5200],
  ["ben", 12_400],
  ["cai", 5200],
] as const) {
  const state = store.load(guild, member);
  state.totalXp = total;
  store.save(guild, member, state);
}

console.log("\n/rank for ana");
console.log("   " + bot.onRankCommand(guild, "ana").replace(/\n/g, "\n   "));

console.log("\n/leaderboard");
console.log("   " + bot.onLeaderboardCommand(guild).replace(/\n/g, "\n   "));

console.log("\nModeration deducts 3000 XP from ben");
const penalised = bot.onWarning(guild, "ben", 3000);
console.log(
  `   ${penalised.previousTotalXp} -> ${penalised.newTotalXp} XP, ` +
    `level ${penalised.previousLevel} -> ${penalised.newLevel}`,
);

console.log("\nA message in the spam channel is worth nothing");
const spam = bot.onMessage(guild, "dee", "spam", []);
console.log(`   outcome: ${spam.outcome} (multiplier 0 -> ${AwardOutcome.NoXp})`);
