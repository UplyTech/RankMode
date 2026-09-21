/**
 * The five things almost every caller needs, in one runnable file.
 *
 *   npx vite-node examples/basic.ts
 *
 * or simply read it -- it is written to be read.
 */
import {
  AwardOutcome,
  buildLeaderboard,
  createEventRule,
  createMemberState,
  deserializeMemberState,
  QuadraticCurve,
  RankEngine,
  rankOf,
  serializeMemberState,
  TieMode,
  type Multiplier,
} from "../src/index.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;

// ------------------------------------------------------------------ setup
const engine = new RankEngine({
  curve: new QuadraticCurve({ base: 100, maxLevel: 100 }),
  rules: [
    createEventRule({
      eventType: "message",
      minXp: 15,
      maxXp: 25,
      cooldownSeconds: 60,
      periodCapXp: 1000,
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
  globalCap: { xp: 2000, periodSeconds: 86400 },
  decay: {
    xpPerPeriod: 25,
    periodSeconds: 86400,
    floorXp: 0,
    graceSeconds: 30 * 86400,
  },
});

// -------------------------------------------------------------- 1. award
console.log("1. A member writes a message");
let state = createMemberState();
const first = engine.award(state, "message", { now: NOW });
console.log(`   ${first.outcome}: +${first.awardedXp} XP -> ${first.newTotalXp}`);
state = first.state; // the caller stores this

// ------------------------------------------------- 2. the cooldown works
console.log("\n2. The same member writes again, ten seconds later");
const blocked = engine.award(state, "message", { now: NOW + 10_000 });
console.log(
  `   ${blocked.outcome}: ${Math.round(blocked.cooldownRemainingMs / 1000)}s left, nothing awarded`,
);

// ------------------------------------------------------ 3. the level-up
console.log("\n3. Fast-forward: the member is one message short of level 3");
const almost = createMemberState(engine.curve.totalXpForLevel(3) - 10);
const levelled = engine.award(almost, "message", { now: NOW, baseXp: 20 });
if (levelled.leveledUp) {
  console.log(`   Level up! ${levelled.previousLevel} -> ${levelled.newLevel}`);
  console.log("   (this is where your bot posts the message and grants the role)");
}

// ------------------------------------------------ 4. the level card data
console.log("\n4. The numbers a level card needs");
const progress = engine.progress(levelled.newTotalXp);
const width = 20;
const filled = Math.floor((progress.progressPermille * width) / 1000);
console.log(`   Level ${progress.level}  [${"#".repeat(filled)}${".".repeat(width - filled)}]`);
console.log(`   ${progress.xpIntoLevel} / ${progress.levelSpan} XP into this level`);
console.log(`   ${progress.xpToNext} XP to level ${progress.level + 1}`);

// --------------------------------------------- 5. a promotion weekend
console.log("\n5. Double XP weekend");
const weekend: Multiplier[] = [{ source: "double-xp-weekend", permille: 2000 }];
const doubled = engine.award(createMemberState(), "message", {
  now: NOW,
  baseXp: 20,
  multipliers: weekend,
});
console.log(`   base ${doubled.baseXp} XP -> awarded ${doubled.awardedXp} XP`);

// ------------------------------------------------------- 6. leaderboard
console.log("\n6. Leaderboard with a tie");
const rows = [
  { memberId: "ana", totalXp: 5000 },
  { memberId: "ben", totalXp: 12_000 },
  { memberId: "cai", totalXp: 5000 },
  { memberId: "dee", totalXp: 800 },
];
for (const entry of buildLeaderboard(engine.curve, rows, { tieMode: TieMode.Competition })) {
  console.log(
    `   #${String(entry.rank).padEnd(2)} ${entry.memberId.padEnd(4)} ` +
      `level ${String(entry.level).padEnd(3)} ${entry.totalXp} XP`,
  );
}
console.log(`   ana alone would ask: rank ${rankOf("ana", rows)}`);

// ------------------------------------------------------- 7. persistence
console.log("\n7. Storing and reloading the state");
const stored = JSON.stringify(serializeMemberState(state));
console.log(`   stored: ${stored}`);
console.log(`   reloaded total: ${deserializeMemberState(JSON.parse(stored)).totalXp}`);

// ------------------------------------------------------------- 8. decay
console.log("\n8. Decay after two months of silence");
const idle = createMemberState(3000);
idle.lastEventAt["message"] = NOW;
const decayed = engine.applyDecay(idle, { now: NOW + 60 * DAY_MS });
if (decayed.outcome === AwardOutcome.Decayed) {
  console.log(`   ${decayed.awardedXp} XP -> ${decayed.newTotalXp}`);
}
