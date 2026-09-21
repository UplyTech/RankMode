#!/usr/bin/env node
/**
 * Generate random cases for the two editions to disagree about.
 *
 * `shared/testcases/` is a fixed list. A fixed list catches a regression in
 * something somebody already thought of - which is exactly why it did not catch
 * the three divergences fixed in 2.0.0, where the disagreement only appears above
 * 2^53 and every vector works below 10^6.
 *
 * This generator produces cases nobody thought of. It is deliberately biased
 * toward the places where the two editions have any reason to differ at all:
 *
 *   - magnitudes near 2^53 - 1, where a JavaScript number stops being exact
 *   - one either side of every threshold, cap and ceiling
 *   - long multiplier chains, where the running value grows with every factor
 *   - curve bases large enough that an intermediate product overflows while
 *     both the input and the answer stay inside the safe range
 *   - rating gaps wide enough that Glicko-2's estimated variance blows up, which
 *     is where `delta^2` reached 10^18 and this edition stopped being exact
 *   - deviations and volatilities at both ends of their ranges, where the
 *     volatility solver's bracket is degenerate
 *
 * It computes nothing itself. It only writes the questions; the two runners
 * answer them, and compare.py decides whether the answers agree.
 *
 *   node generate.mjs --seed 1 --cases 2000 --out cases.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bumped only together with both runners and compare.py. */
const FORMAT_VERSION = 1;

const MAX_TOTAL_XP = 9007199254740991;

// ---------------------------------------------------------------------------
// A deterministic generator, so a red build is always reproducible.
//
// mulberry32, the same algorithm SeededRandomSource uses - not because the
// editions have to agree about it here (only this file runs it) but because
// anybody reading this repository has already met it once.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let random = mulberry32(1);

const pick = (values) => values[Math.floor(random() * values.length)];
const intBetween = (low, high) => low + Math.floor(random() * (high - low + 1));

/**
 * A magnitude, drawn from a distribution that spends most of its time where the
 * bugs are rather than where the numbers are.
 *
 * A uniform draw over [0, 2^53] would almost never produce a small number, and
 * almost never land near a boundary. Both are where divergence lives.
 */
function magnitude() {
  const band = random();
  if (band < 0.25) return intBetween(0, 1000); // everyday
  if (band < 0.45) return intBetween(0, 1_000_000); // a real community
  if (band < 0.6) return intBetween(0, 4_000_000_000); // large
  if (band < 0.75) return intBetween(0, Number.MAX_SAFE_INTEGER / 1000); // wide curves
  if (band < 0.9) return Math.floor(random() * MAX_TOTAL_XP); // anywhere
  // The last band is the interesting one: right at the edge of exactness.
  return MAX_TOTAL_XP - intBetween(0, 4096);
}

/** A value near a boundary rather than merely large. */
function near(value) {
  return value + pick([-2, -1, 0, 1, 2]);
}

// ---------------------------------------------------------------------------
// Curve specifications
// ---------------------------------------------------------------------------
function curveSpec() {
  const kind = pick(["linear", "quadratic", "exponential", "tabular"]);

  if (kind === "tabular") {
    // Ascending, and sometimes with spans wide enough that a permille
    // calculation overflows - which is finding C3.
    const levels = intBetween(1, 12);
    const thresholds = [0];
    let total = 0;
    const step = pick([1, 7, 100, 12_345, 1_000_000_000, 900_719_925_474, 4_503_599_627_370]);
    for (let level = 0; level < levels; level += 1) {
      total += intBetween(1, step);
      if (total > MAX_TOTAL_XP) break;
      thresholds.push(total);
    }
    if (thresholds.length < 2) thresholds.push(1);
    return { kind, thresholds };
  }

  const base = pick([
    1, 7, 25, 50, 100, 999, 12_345, 1_000_000,
    // Bases from here up are where the intermediate product overflows.
    1_000_000_003, 4_294_967_296, 20_000_000_000, 123_456_789_012,
    4_503_599_627_370, 9_007_199_254_740,
  ]);
  const maxLevel = pick([1, 2, 5, 20, 100, 500, 1000, 10000]);

  if (kind === "exponential") {
    return {
      kind,
      base,
      growthPermille: pick([1001, 1010, 1100, 1500, 2000, 3000, 10000]),
      maxLevel,
    };
  }
  return { kind, base, maxLevel };
}

// ---------------------------------------------------------------------------
// The case kinds
// ---------------------------------------------------------------------------

/** Threshold tables, level lookups and progress. Finds C1 and C3. */
function curveCase(id) {
  const spec = curveSpec();
  const probes = [];
  for (let i = 0; i < 12; i += 1) probes.push(magnitude());
  probes.push(-1, 0, 1, MAX_TOTAL_XP);
  // Near every threshold: the only place a level lookup can be off by one.
  probes.push(near(magnitude()));
  return { id, kind: "curve", spec, probes };
}

/** Multiplier chains. Finds C2. */
function multiplierCase(id) {
  const chain = [];
  const length = intBetween(1, 6);
  for (let i = 0; i < length; i += 1) {
    chain.push({
      source: `s${i}`,
      permille: pick([0, 1, 500, 999, 1000, 1001, 1500, 2000, 3000, 10000, intBetween(0, 50000)]),
    });
  }
  return { id, kind: "multipliers", baseXp: magnitude(), chain };
}

/** Whole award sequences: cooldowns, caps, the ceiling, penalties, decay. */
function awardCase(id) {
  const spec = curveSpec();
  const eventTypes = ["message", "voice_minute", "reaction", "post"];
  const rules = [];
  const chosen = eventTypes.slice(0, intBetween(1, eventTypes.length));
  for (const eventType of chosen) {
    const minXp = intBetween(0, 100);
    rules.push({
      eventType,
      minXp,
      maxXp: minXp + intBetween(0, 100),
      cooldownSeconds: pick([0, 0, 1, 30, 60, 120]),
      periodCapXp: pick([null, 0, 1, 100, 1000, 100000]),
      periodSeconds: pick([1, 60, 3600, 86400]),
      enabled: random() < 0.85,
    });
  }

  const config = {
    curve: spec,
    rules,
    globalCap: random() < 0.4 ? { xp: pick([0, 1, 500, 5000]), periodSeconds: pick([60, 86400]) } : null,
    decay:
      random() < 0.4
        ? {
            xpPerPeriod: intBetween(0, 500),
            periodSeconds: pick([60, 3600, 86400]),
            floorXp: pick([0, 10, 100]),
            graceSeconds: pick([0, 60, 604800]),
          }
        : null,
    allowNegative: random() < 0.2,
    maxTotalXp: pick([MAX_TOTAL_XP, MAX_TOTAL_XP, 1000, 100000]),
  };

  // A fixed list rather than a seeded generator: the two editions then need no
  // agreement about a pseudo-random algorithm to agree about award results.
  const randomValues = [];
  for (let i = 0; i < 16; i += 1) randomValues.push(intBetween(0, 200));

  const steps = [];
  let now = 1_700_000_000_000;
  const stepCount = intBetween(1, 14);
  for (let i = 0; i < stepCount; i += 1) {
    now += pick([0, 1, 999, 1000, 30_000, 59_999, 60_000, 60_001, 86_400_000, 604_800_000]);
    const op = random();
    if (op < 0.7) {
      const multipliers = [];
      if (random() < 0.35) {
        for (let m = 0; m < intBetween(1, 3); m += 1) {
          multipliers.push({ source: `m${m}`, permille: pick([0, 500, 1000, 1500, 2000, 5000]) });
        }
      }
      steps.push({
        op: "award",
        // An unknown event type is a normal outcome, so it is generated too.
        eventType: random() < 0.9 ? pick(chosen) : "unknown_event",
        now,
        baseXp: random() < 0.25 ? magnitude() : null,
        multipliers,
      });
    } else if (op < 0.85) {
      steps.push({ op: "penalize", amount: magnitude(), now, resetCooldownFor: random() < 0.3 ? chosen : [] });
    } else if (op < 0.95) {
      steps.push({ op: "decay", now });
    } else {
      steps.push({ op: "prune", now, keepCooldownMs: pick([0, 60_000, 86_400_000]) });
    }
  }

  return { id, kind: "award", config, initialTotalXp: magnitude(), randomValues, steps };
}

/** Ranking and ties. */
function leaderboardCase(id) {
  const rows = [];
  const count = intBetween(0, 24);
  for (let i = 0; i < count; i += 1) {
    // Duplicated totals on purpose: ties are the part callers get wrong, and
    // the part the two editions could sort differently.
    rows.push({ memberId: `m${i}`, totalXp: random() < 0.4 ? pick([0, 100, 1000, MAX_TOTAL_XP]) : magnitude() });
  }
  return {
    id,
    kind: "leaderboard",
    spec: curveSpec(),
    rows,
    tieMode: pick(["COMPETITION", "DENSE", "ORDINAL"]),
    offset: intBetween(0, 3),
    limit: pick([null, 0, 1, 5, 100]),
  };
}

/** Curve changes. */
function migrationCase(id) {
  const totals = [];
  for (let i = 0; i < intBetween(1, 10); i += 1) totals.push(magnitude());
  return {
    id,
    kind: "migration",
    from: curveSpec(),
    to: curveSpec(),
    totals,
    strategy: pick(["PRESERVE_LEVEL", "PRESERVE_PROGRESS", "PRESERVE_XP"]),
  };
}

/** The state a caller stores and loads back. */
function stateCase(id) {
  const keys = ["message", "voice_minute", "*"];
  const map = () => {
    const out = {};
    for (const key of keys) if (random() < 0.6) out[key] = magnitude();
    return out;
  };
  return {
    id,
    kind: "state",
    state: {
      totalXp: magnitude(),
      lastEventAt: map(),
      periodStartAt: map(),
      periodAwardedXp: map(),
      lastDecayAt: random() < 0.5 ? magnitude() : null,
    },
    pruneNow: magnitude(),
    keepCooldownMs: pick([0, 60_000, 86_400_000]),
  };
}

// ---------------------------------------------------------------------------
// The ranked system
// ---------------------------------------------------------------------------

/**
 * A rating, drawn where the two editions have a reason to differ.
 *
 * The wide gaps matter most: at a difference of about 2000 points Glicko-2's
 * expected score rounds to a handful of micro-units, the estimated variance is
 * its reciprocal, and `delta^2` reaches 10^18 - past the last integer a double
 * represents exactly. That is the band the ranked half of this library was
 * fixed for, and a uniform draw would hardly ever visit it.
 */
function rating() {
  const band = random();
  let value;
  if (band < 0.15) value = intBetween(0, 200); // the floor
  else if (band < 0.3) value = intBetween(4800, 5000); // the ceiling
  else if (band < 0.5) value = near(pick([0, 800, 1100, 1400, 1700, 2000, 2300, 2600, 2900]));
  else value = intBetween(0, 5000);

  return {
    rating: Math.max(0, Math.min(5000, value)),
    deviation: pick([1, 5, 30, 31, 60, 100, 175, 250, 349, 350]),
    volatility: pick([1_000, 1_001, 10_000, 30_000, 60_000, 120_000, 300_000, 499_999, 500_000]),
    matchesPlayed: pick([0, 1, 9, 10, 11, 100, 5000]),
  };
}

const OUTCOMES = ["WIN", "LOSS", "DRAW"];
const SYSTEMS = ["ELO", "GLICKO2"];

/** Expected scores, single updates and whole rating periods. */
function ratingCase(id) {
  const results = [];
  for (let i = 0; i < intBetween(0, 6); i += 1) {
    results.push({ opponent: rating(), outcome: pick(OUTCOMES) });
  }
  return {
    id,
    kind: "rating",
    player: rating(),
    opponent: rating(),
    outcome: pick(OUTCOMES),
    // An empty list is generated on purpose: the idle period is a code path of
    // its own, and it is where the deviation decay had a fixed point.
    results,
    confidencePermille: pick([680, 900, 950, 990]),
  };
}

/** Ladder brackets, League Points, promotion series and season resets. */
function ladderCase(id) {
  const apex = pick([false, false, false, true]);
  const tier = apex
    ? pick(["MASTER", "GRANDMASTER", "CHALLENGER"])
    : pick(["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "DIAMOND"]);

  const series =
    random() < 0.25
      ? {
          winsNeeded: pick([1, 2, 3, 5]),
          lossesAllowed: pick([0, 1, 2, 4]),
          wins: intBetween(0, 3),
          losses: intBetween(0, 3),
        }
      : null;

  return {
    id,
    kind: "ladder",
    from: {
      tier,
      division: apex ? null : pick([1, 2, 3, 4]),
      // Above apex the points are unbounded, which is its own arithmetic.
      leaguePoints: apex ? intBetween(0, 3000) : intBetween(0, 99),
      series,
    },
    won: random() < 0.5,
    rating: intBetween(0, 5000),
    matchesSincePromotion: pick([0, 1, 2, 3, 4, 999]),
    config: {
      pointsPerDivision: pick([1, 25, 100, 100, 1000]),
      basePointsGain: pick([0, 1, 20, 20, 99]),
      basePointsLoss: pick([0, 1, 18, 18, 99]),
      adjustmentSpanPermille: pick([0, 250, 500, 500, 1000]),
      seriesWinsNeeded: pick([1, 3, 3, 5]),
      seriesLossesAllowed: pick([0, 2, 2, 4]),
      seriesOnTierPromotion: random() < 0.8,
      demotionProtectionMatches: pick([0, 3, 3, 10]),
      allowTierDemotion: random() < 0.85,
    },
    seedProbes: [
      intBetween(0, 5000),
      near(pick([0, 800, 1100, 1400, 1700, 2000, 2300, 2600, 2900])),
      0,
      5000,
    ],
    reset: {
      policy: pick(["NONE", "SOFT", "SOFT", "HARD"]),
      pullPermille: pick([0, 1, 250, 500, 999, 1000]),
      meanRating: pick([1000, 1500, 1500, 2000]),
    },
  };
}

/**
 * A whole season through the engine.
 *
 * The only case kind that carries state forward, and therefore the only one
 * that can find a divergence which needs a hundred updates before it is a whole
 * rating point.
 */
function rankedCase(id) {
  const matches = [];
  for (let i = 0; i < intBetween(1, 40); i += 1) {
    matches.push({ opponent: rating(), outcome: pick(OUTCOMES) });
  }
  return {
    id,
    kind: "ranked",
    system: pick(SYSTEMS),
    start: rating(),
    placementMatches: pick([0, 1, 5, 10, 10, 20]),
    streakThreshold: pick([0, 2, 3, 3, 5]),
    streakBonusPoints: pick([0, 1, 2, 5]),
    maxStreakBonus: pick([0, 5, 10, 50]),
    withSeason: random() < 0.7,
    matches,
  };
}

/** Match quality and team balancing. */
function matchmakingCase(id) {
  const players = [];
  for (let i = 0; i < 2 * intBetween(1, 4); i += 1) players.push(rating());
  return {
    id,
    kind: "matchmaking",
    left: rating(),
    right: rating(),
    system: pick(SYSTEMS),
    minimumQualityPermille: pick([0, 200, 400, 800, 1000]),
    maximumGap: pick([null, 0, 100, 500, 5000]),
    players,
  };
}

const KINDS = [
  curveCase,
  multiplierCase,
  awardCase,
  leaderboardCase,
  migrationCase,
  stateCase,
  ratingCase,
  ladderCase,
  rankedCase,
  matchmakingCase,
];

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };

  const seed = Number(flag("seed", "1"));
  const count = Number(flag("cases", "2000"));
  const out = flag("out", join(HERE, "cases.json"));

  if (!Number.isInteger(seed) || !Number.isInteger(count) || count < 1) {
    console.error("usage: generate.mjs --seed <int> --cases <int> --out <path>");
    process.exit(2);
  }

  random = mulberry32(seed);

  const cases = [];
  for (let i = 0; i < count; i += 1) {
    cases.push(KINDS[i % KINDS.length](`c${i}`));
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ formatVersion: FORMAT_VERSION, seed, cases }, null, 1)}\n`, "utf8");
  console.log(`wrote ${cases.length} cases (seed ${seed}) to ${out}`);
}

main();
