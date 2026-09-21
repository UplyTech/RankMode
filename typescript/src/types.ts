import type { Curve } from "./curves.js";

/**
 * Where a level sits on the curve, and how far into it a member is.
 *
 * Progress is expressed in permille (0..1000) rather than as a float so that
 * the Python and TypeScript editions cannot drift apart through rounding.
 */
export interface LevelProgress {
  /** The level the member currently holds. */
  readonly level: number;
  /** The total the progress was computed from. */
  readonly totalXp: number;
  /** Total required to reach `level`. */
  readonly currentThreshold: number;
  /** Total required to reach `level + 1`, or `null` at the top of the curve. */
  readonly nextThreshold: number | null;
  /** How far past `currentThreshold` the member is. */
  readonly xpIntoLevel: number;
  /** How much is still missing for the next level, or `null` at the top. */
  readonly xpToNext: number | null;
  /** Width of the current level in XP, or `null` at the top. */
  readonly levelSpan: number | null;
  /** 0..1000. Always 1000 once the top of the curve is reached. */
  readonly progressPermille: number;
  /**
   * Progress as a 0.0..1.0 float, for display only.
   *
   * Never feed this back into a calculation: `progressPermille` is the
   * authoritative value, and it is what the shared test vectors pin down.
   */
  readonly progressRatio: number;
  /** True when `level` is the highest level the curve knows. */
  readonly isMaxLevel: boolean;
}

/**
 * A factor applied to the base XP of a single award.
 *
 * `permille` is an integer: 1000 = x1.0, 1500 = x1.5, 2000 = double XP.
 * Where the factor comes from — a role, a channel, a promotion weekend — is
 * the caller's business; RankMode only needs the number and a name for it.
 */
export interface Multiplier {
  readonly source: string;
  readonly permille: number;
}

/** What an event is worth, plus its abuse limits. */
export interface EventRule {
  /** Identifier the caller passes to `RankEngine.award`. */
  readonly eventType: string;
  /** Lower bound of the random span, inclusive. */
  readonly minXp: number;
  /** Upper bound of the random span, inclusive. Equal to `minXp` = fixed award. */
  readonly maxXp: number;
  /** Minimum distance between two paying events of this type, per member. */
  readonly cooldownSeconds: number;
  /** Ceiling per period, or `null` for no ceiling. */
  readonly periodCapXp: number | null;
  /** Length of the capping period. Defaults to 24 h. */
  readonly periodSeconds: number;
  /** A disabled rule awards nothing and reports `AwardOutcome.RuleDisabled`. */
  readonly enabled: boolean;
}

/** Loose input accepted when building an {@link EventRule}. */
export interface EventRuleInput {
  readonly eventType: string;
  readonly minXp: number;
  readonly maxXp?: number;
  readonly cooldownSeconds?: number;
  readonly periodCapXp?: number | null;
  readonly periodSeconds?: number;
  readonly enabled?: boolean;
}

/** A ceiling that applies across all event types together. */
export interface GlobalCap {
  readonly xp: number;
  readonly periodSeconds: number;
}

/** Optional XP decay, so leaderboards stay current instead of historical. */
export interface DecayRule {
  /** XP removed per elapsed period. */
  readonly xpPerPeriod: number;
  /** Length of one decay period in seconds. */
  readonly periodSeconds: number;
  /** Decay never pushes a total below this. */
  readonly floorXp: number;
  /** No decay until this much time has passed since the last paying event. */
  readonly graceSeconds: number;
}

/**
 * Everything RankMode needs to know about a single member.
 *
 * The caller owns this object: read it from your database, hand it in, store
 * the copy that comes back. RankMode never writes it anywhere itself.
 */
export interface MemberState {
  /** Current total. */
  totalXp: number;
  /** event type -> epoch milliseconds of the last paying event. */
  lastEventAt: Record<string, number>;
  /** event type (or `*` for the global cap) -> start of the running period. */
  periodStartAt: Record<string, number>;
  /** event type (or `*`) -> XP already awarded inside the running period. */
  periodAwardedXp: Record<string, number>;
  /** Epoch milliseconds of the last decay run, or `null` if it never ran. */
  lastDecayAt: number | null;
}

/** Why an award turned out the way it did. */
export enum AwardOutcome {
  /** XP was granted. */
  Awarded = "AWARDED",
  /** The member's cooldown for this event type has not expired yet. */
  Cooldown = "COOLDOWN",
  /** The period ceiling for this event type or the global one is exhausted. */
  PeriodCap = "PERIOD_CAP",
  /** The rule exists but is switched off. */
  RuleDisabled = "RULE_DISABLED",
  /** No rule matched the event type and no default rule is configured. */
  UnknownEvent = "UNKNOWN_EVENT",
  /** The total is already at the configured ceiling. */
  MaxXpReached = "MAX_XP_REACHED",
  /** The rule matched but the computed amount was zero. */
  NoXp = "NO_XP",
  /** XP was deducted by `RankEngine.penalize`. */
  Penalised = "PENALISED",
  /** XP was removed by `RankEngine.applyDecay`. */
  Decayed = "DECAYED",
  /** Decay ran but nothing was due. */
  NoDecayDue = "NO_DECAY_DUE",
}

/** The result of every state-changing engine call. */
export interface AwardResult {
  readonly outcome: AwardOutcome;
  /** True when the total moved. The usual "do I need to write?" check. */
  readonly changed: boolean;
  /** Signed. Positive for awards, negative for penalties and decay. */
  readonly awardedXp: number;
  /** What the rule rolled before multipliers and caps. */
  readonly baseXp: number;
  /** Product of all applied multipliers, in permille. */
  readonly multiplierPermille: number;
  readonly previousTotalXp: number;
  readonly newTotalXp: number;
  readonly previousLevel: number;
  readonly newLevel: number;
  readonly leveledUp: boolean;
  readonly leveledDown: boolean;
  /** Progress after the change — the numbers a level card wants. */
  readonly progress: LevelProgress;
  /** The rule that was applied, or `null`. */
  readonly rule: EventRule | null;
  /** Milliseconds until the cooldown expires. `0` when it is not active. */
  readonly cooldownRemainingMs: number;
  /** XP still available in the running period, or `null` when uncapped. */
  readonly periodRemainingXp: number | null;
  /** The new state. Persist this; the input state is left untouched. */
  readonly state: MemberState;
}

/** How to number members that hold the same total. */
export enum TieMode {
  /** 1, 2, 2, 4 — the usual sports ranking. */
  Competition = "COMPETITION",
  /** 1, 2, 2, 3 — no gaps after a tie. */
  Dense = "DENSE",
  /** 1, 2, 3, 4 — ties broken by input order. */
  Ordinal = "ORDINAL",
}

/** One row of a leaderboard. */
export interface LeaderboardEntry {
  readonly memberId: string;
  readonly totalXp: number;
  readonly level: number;
  /** Rank under the selected {@link TieMode}. */
  readonly rank: number;
  /** Competition rank (1, 2, 2, 4), always present for reference. */
  readonly competitionRank: number;
  /** Dense rank (1, 2, 2, 3), always present for reference. */
  readonly denseRank: number;
  /** Zero-based position in the sorted list, before `offset` and `limit`. */
  readonly position: number;
  readonly progress: LevelProgress;
}

/** Input row for `buildLeaderboard`. */
export interface LeaderboardInput {
  readonly memberId: string;
  readonly totalXp: number;
}

/** How a curve change should treat the totals of existing members. */
export enum MigrationStrategy {
  /**
   * Keep the level, drop the progress inside it. Nobody loses a level; nobody
   * keeps a nearly finished level bar.
   */
  PreserveLevel = "PRESERVE_LEVEL",
  /**
   * Keep the level *and* the progress inside it. The recommended default for a
   * live community: the level bar looks the same after the switch.
   */
  PreserveProgress = "PRESERVE_PROGRESS",
  /** Keep the raw total. Levels move — only sensible for a fresh scope. */
  PreserveXp = "PRESERVE_XP",
}

/** What a migration did to a single total. */
export interface MigrationResult {
  readonly strategy: MigrationStrategy;
  readonly previousTotalXp: number;
  readonly newTotalXp: number;
  readonly previousLevel: number;
  readonly newLevel: number;
  readonly levelDelta: number;
  readonly previousProgressPermille: number;
  readonly newProgressPermille: number;
  /**
   * True when the new curve is shorter than the member's old level, so they
   * were placed at its top instead.
   *
   * Until 2.0.0 this field was called `clampedToKeepLevel` and documented as
   * "the member would have lost a level and was topped up instead" - the
   * opposite of what it has always been set for. A boolean whose name is the
   * negation of its meaning produces a correct-looking `if` that is backwards.
   */
  readonly clampedToCurveTop: boolean;
}

/** Configuration handed to `RankEngine` once, at construction. */
export interface RankConfigInput {
  readonly curve?: Curve;
  readonly rules?: readonly (EventRule | EventRuleInput)[];
  readonly defaultRule?: EventRule | EventRuleInput | null;
  readonly globalCap?: GlobalCap | null;
  readonly decay?: DecayRule | null;
  /**
   * Allow totals below zero. Off by default — a negative total is almost
   * always a bug, and it makes leaderboards read strangely.
   */
  readonly allowNegative?: boolean;
  /** Hard ceiling for totals. Clamped to `MAX_TOTAL_XP`. */
  readonly maxTotalXp?: number;
}

/** The frozen, validated form of {@link RankConfigInput}. */
export interface RankConfig {
  readonly curve: Curve;
  readonly rules: ReadonlyMap<string, EventRule>;
  readonly defaultRule: EventRule | null;
  readonly globalCap: GlobalCap | null;
  readonly decay: DecayRule | null;
  readonly allowNegative: boolean;
  readonly maxTotalXp: number;
}
