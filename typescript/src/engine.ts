import {
  DEFAULT_PERIOD_SECONDS,
  GLOBAL_CAP_KEY,
  MAX_TOTAL_XP,
  MIN_TOTAL_XP,
  PERMILLE_ONE,
} from "./constants.js";
import { Curve, defaultCurve } from "./curves.js";
import { ConfigurationError, ValidationError, XpOverflowError } from "./errors.js";
import { mulDivFloor } from "./exact.js";
import { CryptoRandomSource, type RandomSource } from "./random.js";
import { cloneMemberState, createMemberState } from "./state.js";
import {
  AwardOutcome,
  type AwardResult,
  type DecayRule,
  type EventRule,
  type EventRuleInput,
  type GlobalCap,
  type LevelProgress,
  type MemberState,
  type Multiplier,
  type RankConfig,
  type RankConfigInput,
} from "./types.js";

/** Options for a single {@link RankEngine.award} call. */
export interface AwardOptions {
  /**
   * Current time in epoch milliseconds.
   *
   * Handed in rather than read from the system clock, because a cooldown that
   * depends on the wall clock cannot be tested.
   */
  readonly now: number;
  /** Factors from roles, channels or a promotion weekend. */
  readonly multipliers?: readonly Multiplier[];
  /** Where the random span comes from. Defaults to {@link CryptoRandomSource}. */
  readonly random?: RandomSource;
  /**
   * Skip the random roll and use this base value instead.
   *
   * For events whose worth the caller already knows — a voice minute, a forum
   * post of a measured length — and for reproducing a reported award.
   */
  readonly baseXp?: number;
}

/** Options for {@link RankEngine.penalize}. */
export interface PenalizeOptions {
  readonly now: number;
  /**
   * Let the deduction consume the cooldown as well, so a member cannot
   * immediately earn the XP back. Off by default.
   */
  readonly resetCooldownFor?: readonly string[];
}

/**
 * The rank engine: rules and a curve in, a result out.
 *
 * Every method is pure with respect to its arguments — the state handed in is
 * never modified, and a fresh state comes back in the result. Nothing is
 * stored, nothing is logged, no clock and no random generator is read from the
 * environment.
 */
export class RankEngine {
  public readonly config: RankConfig;

  constructor(input: RankConfigInput = {}) {
    this.config = freezeConfig(input);
  }

  /** The configured curve. */
  public get curve(): Curve {
    return this.config.curve;
  }

  /** Progress information for a total, without touching any state. */
  public progress(totalXp: number): LevelProgress {
    return this.config.curve.progressForTotalXp(totalXp);
  }

  /** The level a total corresponds to. */
  public levelFor(totalXp: number): number {
    return this.config.curve.levelForTotalXp(totalXp);
  }

  /** The rule for an event type, or the default rule, or `null`. */
  public ruleFor(eventType: string): EventRule | null {
    return this.config.rules.get(eventType) ?? this.config.defaultRule;
  }

  /** Milliseconds until the member may earn from `eventType` again. */
  public cooldownRemainingMs(
    state: MemberState,
    eventType: string,
    now: number,
  ): number {
    const rule = this.ruleFor(eventType);
    if (rule === null || rule.cooldownSeconds <= 0) {
      return 0;
    }
    const last = state.lastEventAt[eventType];
    if (last === undefined) {
      return 0;
    }
    const remaining = rule.cooldownSeconds * 1000 - (now - last);
    return remaining > 0 ? remaining : 0;
  }

  /** True when the member could earn from `eventType` right now. */
  public canAward(state: MemberState, eventType: string, now: number): boolean {
    const rule = this.ruleFor(eventType);
    if (rule === null || !rule.enabled) {
      return false;
    }
    if (this.cooldownRemainingMs(state, eventType, now) > 0) {
      return false;
    }
    const remaining = this.periodRemainingXp(state, eventType, now);
    return remaining === null || remaining > 0;
  }

  /**
   * XP still available to `eventType` in the running period.
   *
   * Takes the global cap into account, so this is the number that actually
   * limits the next award — `null` means nothing limits it.
   */
  public periodRemainingXp(
    state: MemberState,
    eventType: string,
    now: number,
  ): number | null {
    const rule = this.ruleFor(eventType);
    const limits: number[] = [];
    if (rule !== null && rule.periodCapXp !== null) {
      limits.push(
        remainingInPeriod(state, eventType, rule.periodCapXp, rule.periodSeconds, now),
      );
    }
    const globalCap = this.config.globalCap;
    if (globalCap !== null) {
      limits.push(
        remainingInPeriod(
          state,
          GLOBAL_CAP_KEY,
          globalCap.xp,
          globalCap.periodSeconds,
          now,
        ),
      );
    }
    if (limits.length === 0) {
      return null;
    }
    return Math.min(...limits);
  }

  /**
   * Award XP for an event.
   *
   * The order of checks is fixed and part of the public contract, because a
   * different order produces different numbers:
   *
   * 1. find the rule — unknown event type awards nothing
   * 2. rule disabled — awards nothing
   * 3. cooldown — awards nothing, and does **not** restart the cooldown
   * 4. roll the base value from the span
   * 5. apply the multipliers, in the order they were handed in
   * 6. trim to what is left of the period caps
   * 7. trim to the configured ceiling
   * 8. write the new total, the cooldown stamp and the period counters
   *
   * Steps 3, 6 and 7 return an outcome rather than throwing: an exhausted
   * cooldown is a normal state of affairs, not an error.
   */
  public award(
    state: MemberState,
    eventType: string,
    options: AwardOptions,
  ): AwardResult {
    assertTimestamp(options.now);
    const previousTotalXp = state.totalXp;
    const previousLevel = this.levelFor(previousTotalXp);
    const rule = this.ruleFor(eventType);

    if (rule === null) {
      return this.unchanged(state, AwardOutcome.UnknownEvent, null, previousLevel, 0);
    }
    if (!rule.enabled) {
      return this.unchanged(state, AwardOutcome.RuleDisabled, rule, previousLevel, 0);
    }

    const cooldownRemaining = this.cooldownRemainingMs(state, eventType, options.now);
    if (cooldownRemaining > 0) {
      return this.unchanged(
        state,
        AwardOutcome.Cooldown,
        rule,
        previousLevel,
        cooldownRemaining,
      );
    }

    if (previousTotalXp >= this.config.maxTotalXp) {
      return this.unchanged(state, AwardOutcome.MaxXpReached, rule, previousLevel, 0);
    }

    // 4. Base value.
    let baseXp: number;
    if (options.baseXp !== undefined) {
      if (!Number.isSafeInteger(options.baseXp) || options.baseXp < 0) {
        throw new ValidationError("baseXp override must be a non-negative integer", {
          baseXp: options.baseXp,
        });
      }
      baseXp = options.baseXp;
    } else if (rule.minXp === rule.maxXp) {
      // No roll at all when the span is a single value — keeps the random
      // source untouched, which makes fixed-value rules trivially testable.
      baseXp = rule.minXp;
    } else {
      const random = options.random ?? new CryptoRandomSource();
      baseXp = random.randomInt(rule.minXp, rule.maxXp);
    }

    // 5. Multipliers.
    const multipliers = options.multipliers ?? [];
    const multiplierPermille = combinedPermille(multipliers);
    let amount = applyMultipliers(baseXp, multipliers);

    // 6. Period caps.
    const periodRemaining = this.periodRemainingXp(state, eventType, options.now);
    if (periodRemaining !== null) {
      if (periodRemaining <= 0) {
        return this.unchanged(
          state,
          AwardOutcome.PeriodCap,
          rule,
          previousLevel,
          0,
          periodRemaining,
        );
      }
      if (amount > periodRemaining) {
        amount = periodRemaining;
      }
    }

    // 7. Ceiling.
    const headroom = this.config.maxTotalXp - previousTotalXp;
    let clampedByCeiling = false;
    if (amount > headroom) {
      amount = headroom;
      clampedByCeiling = true;
    }

    if (amount <= 0) {
      return this.unchanged(
        state,
        clampedByCeiling ? AwardOutcome.MaxXpReached : AwardOutcome.NoXp,
        rule,
        previousLevel,
        0,
        periodRemaining,
      );
    }

    // 8. New state.
    const next = cloneMemberState(state);
    next.totalXp = previousTotalXp + amount;
    // Stamped for every paying award, including rules with no cooldown.
    // Until 2.0.0 this was written only when `cooldownSeconds > 0`, which made
    // a zero-cooldown rule - a voice minute, say - invisible to `applyDecay`:
    // a member active every day still decayed, because decay looks here to find
    // out when they were last active. `cooldownRemainingMs` returns 0 for a
    // rule without a cooldown, so nothing else changes, and
    // `pruneMemberState` is what keeps the map small.
    next.lastEventAt[eventType] = options.now;
    if (rule.periodCapXp !== null) {
      recordInPeriod(next, eventType, amount, rule.periodSeconds, options.now);
    }
    if (this.config.globalCap !== null) {
      recordInPeriod(
        next,
        GLOBAL_CAP_KEY,
        amount,
        this.config.globalCap.periodSeconds,
        options.now,
      );
    }

    const newLevel = this.levelFor(next.totalXp);
    return {
      outcome: AwardOutcome.Awarded,
      changed: true,
      awardedXp: amount,
      baseXp,
      multiplierPermille,
      previousTotalXp,
      newTotalXp: next.totalXp,
      previousLevel,
      newLevel,
      leveledUp: newLevel > previousLevel,
      leveledDown: false,
      progress: this.progress(next.totalXp),
      rule,
      cooldownRemainingMs: rule.cooldownSeconds * 1000,
      periodRemainingXp: this.periodRemainingXp(next, eventType, options.now),
      state: next,
    };
  }

  /**
   * Deduct XP — the counterpart moderation needs.
   *
   * Unless `allowNegative` is configured, the total stops at zero rather than
   * going below it. A level loss is reported through `leveledDown`, so the
   * caller can remove a role in the same place it grants one.
   */
  public penalize(
    state: MemberState,
    amount: number,
    options: PenalizeOptions,
  ): AwardResult {
    assertTimestamp(options.now);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new ValidationError("Penalty amount must be a non-negative integer", {
        amount,
      });
    }

    const previousTotalXp = state.totalXp;
    const previousLevel = this.levelFor(previousTotalXp);
    const floor = this.config.allowNegative ? MIN_TOTAL_XP : 0;
    let removed = amount;
    if (previousTotalXp - removed < floor) {
      removed = previousTotalXp - floor;
    }
    if (removed < 0) {
      removed = 0;
    }

    const next = cloneMemberState(state);
    next.totalXp = previousTotalXp - removed;
    for (const eventType of options.resetCooldownFor ?? []) {
      next.lastEventAt[eventType] = options.now;
    }

    const newLevel = this.levelFor(next.totalXp);
    return {
      outcome: removed > 0 ? AwardOutcome.Penalised : AwardOutcome.NoXp,
      changed: removed !== 0,
      // `-removed` rather than `0 - removed`, and normalised: JavaScript has a
      // negative zero and Python's integers do not, so `-0` here would be a
      // reported value the two editions disagree about. `Object.is(-0, 0)` is
      // false, and a caller comparing or keying on this field would see it.
      awardedXp: removed === 0 ? 0 : -removed,
      baseXp: amount,
      multiplierPermille: PERMILLE_ONE,
      previousTotalXp,
      newTotalXp: next.totalXp,
      previousLevel,
      newLevel,
      leveledUp: false,
      leveledDown: newLevel < previousLevel,
      progress: this.progress(next.totalXp),
      rule: null,
      cooldownRemainingMs: 0,
      periodRemainingXp: null,
      state: next,
    };
  }

  /**
   * Apply the configured decay.
   *
   * Decay is charged per whole elapsed period, so calling this once a day or
   * once a week produces the same result — the caller decides when to run it,
   * not how much it costs.
   */
  public applyDecay(state: MemberState, options: { now: number }): AwardResult {
    assertTimestamp(options.now);
    const rule = this.config.decay;
    const previousTotalXp = state.totalXp;
    const previousLevel = this.levelFor(previousTotalXp);

    if (rule === null) {
      return this.unchanged(state, AwardOutcome.NoDecayDue, null, previousLevel, 0);
    }

    const decayStart = decayStartAt(state, rule, options.now);
    if (options.now <= decayStart) {
      const next = cloneMemberState(state);
      next.lastDecayAt = state.lastDecayAt ?? options.now;
      return {
        ...this.unchanged(state, AwardOutcome.NoDecayDue, null, previousLevel, 0),
        state: next,
      };
    }

    const periodMs = rule.periodSeconds * 1000;
    const periods = Math.floor((options.now - decayStart) / periodMs);
    if (periods <= 0) {
      return this.unchanged(state, AwardOutcome.NoDecayDue, null, previousLevel, 0);
    }

    let removed = periods * rule.xpPerPeriod;
    const floor = Math.max(rule.floorXp, this.config.allowNegative ? MIN_TOTAL_XP : 0);
    if (previousTotalXp - removed < floor) {
      removed = previousTotalXp - floor;
    }
    if (removed < 0) {
      removed = 0;
    }

    const next = cloneMemberState(state);
    next.totalXp = previousTotalXp - removed;
    next.lastDecayAt = decayStart + periods * periodMs;

    const newLevel = this.levelFor(next.totalXp);
    return {
      outcome: removed > 0 ? AwardOutcome.Decayed : AwardOutcome.NoDecayDue,
      changed: removed !== 0,
      // `-removed` rather than `0 - removed`, and normalised: JavaScript has a
      // negative zero and Python's integers do not, so `-0` here would be a
      // reported value the two editions disagree about. `Object.is(-0, 0)` is
      // false, and a caller comparing or keying on this field would see it.
      awardedXp: removed === 0 ? 0 : -removed,
      baseXp: periods * rule.xpPerPeriod,
      multiplierPermille: PERMILLE_ONE,
      previousTotalXp,
      newTotalXp: next.totalXp,
      previousLevel,
      newLevel,
      leveledUp: false,
      leveledDown: newLevel < previousLevel,
      progress: this.progress(next.totalXp),
      rule: null,
      cooldownRemainingMs: 0,
      periodRemainingXp: null,
      state: next,
    };
  }

  /**
   * How long until the member reaches `targetLevel`, given a rate.
   *
   * A convenience for the "when do I level up?" question every community asks.
   * `xpPerHour` is the caller's own estimate — RankMode keeps no history it
   * could derive one from.
   */
  public estimateTimeToLevel(
    totalXp: number,
    targetLevel: number,
    xpPerHour: number,
  ): number | null {
    if (!Number.isFinite(xpPerHour) || xpPerHour <= 0) {
      throw new ValidationError("xpPerHour must be a positive number", { xpPerHour });
    }
    const target = this.config.curve.totalXpForLevel(targetLevel);
    const missing = target - totalXp;
    if (missing <= 0) {
      return 0;
    }
    return Math.ceil((missing / xpPerHour) * 3600 * 1000);
  }

  private unchanged(
    state: MemberState,
    outcome: AwardOutcome,
    rule: EventRule | null,
    previousLevel: number,
    cooldownRemainingMs: number,
    periodRemainingXp: number | null = null,
  ): AwardResult {
    return {
      outcome,
      changed: false,
      awardedXp: 0,
      baseXp: 0,
      multiplierPermille: PERMILLE_ONE,
      previousTotalXp: state.totalXp,
      newTotalXp: state.totalXp,
      previousLevel,
      newLevel: previousLevel,
      leveledUp: false,
      leveledDown: false,
      progress: this.progress(state.totalXp),
      rule,
      cooldownRemainingMs,
      periodRemainingXp,
      state: cloneMemberState(state),
    };
  }
}

/**
 * Build a validated {@link EventRule} from loose input.
 *
 * Exported because callers usually want to define their rules once, in a
 * config file, and have the values checked before the bot starts rather than
 * on the first message.
 */
export function createEventRule(input: EventRuleInput): EventRule {
  const minXp = input.minXp;
  const maxXp = input.maxXp ?? input.minXp;
  const cooldownSeconds = input.cooldownSeconds ?? 0;
  const periodCapXp = input.periodCapXp ?? null;
  const periodSeconds = input.periodSeconds ?? DEFAULT_PERIOD_SECONDS;

  if (typeof input.eventType !== "string" || input.eventType.length === 0) {
    throw new ConfigurationError("An event rule needs a non-empty event type", {
      eventType: input.eventType,
    });
  }
  if (input.eventType === GLOBAL_CAP_KEY) {
    throw new ConfigurationError(
      `The event type ${GLOBAL_CAP_KEY} is reserved for the global cap`,
      { eventType: input.eventType },
    );
  }
  if (!Number.isSafeInteger(minXp) || minXp < 0) {
    throw new ConfigurationError("minXp must be a non-negative integer", { minXp });
  }
  if (!Number.isSafeInteger(maxXp) || maxXp < minXp) {
    throw new ConfigurationError("maxXp must be an integer of at least minXp", {
      minXp,
      maxXp,
    });
  }
  if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0) {
    throw new ConfigurationError("cooldownSeconds must be a non-negative integer", {
      cooldownSeconds,
    });
  }
  if (periodCapXp !== null && (!Number.isSafeInteger(periodCapXp) || periodCapXp < 0)) {
    throw new ConfigurationError("periodCapXp must be a non-negative integer or null", {
      periodCapXp,
    });
  }
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
    throw new ConfigurationError("periodSeconds must be a positive integer", {
      periodSeconds,
    });
  }

  return Object.freeze({
    eventType: input.eventType,
    minXp,
    maxXp,
    cooldownSeconds,
    periodCapXp,
    periodSeconds,
    enabled: input.enabled ?? true,
  });
}

/**
 * The rule set the concept describes as the sensible starting point.
 *
 * A text message every minute, a voice minute, a reaction that is worth
 * something but not much, and a forum post for the callers that are not
 * Discord at all.
 */
export function defaultRules(): EventRule[] {
  return [
    createEventRule({
      eventType: "message",
      minXp: 15,
      maxXp: 25,
      cooldownSeconds: 60,
      periodCapXp: 1000,
    }),
    createEventRule({
      eventType: "voice_minute",
      minXp: 5,
      maxXp: 10,
      cooldownSeconds: 0,
      periodCapXp: 1500,
    }),
    createEventRule({
      eventType: "reaction",
      minXp: 1,
      maxXp: 2,
      cooldownSeconds: 30,
      periodCapXp: 100,
    }),
    createEventRule({
      eventType: "post",
      minXp: 20,
      maxXp: 40,
      cooldownSeconds: 120,
      periodCapXp: 800,
    }),
  ];
}

/**
 * Multiply a base value by a chain of permille factors.
 *
 * Applied one after another with integer floor division, in the order given.
 * The order is part of the contract: `floor(floor(x * a) * b)` is not always
 * `floor(floor(x * b) * a)`, and two editions that disagree about the order
 * would disagree about the result.
 *
 * Throws {@link XpOverflowError} if the running value leaves the shared safe
 * range. That is a programming mistake rather than a normal outcome: no rule
 * this library will build can roll a base large enough to reach it, so getting
 * there means a `baseXp` override or a permille factor that was never meant to
 * be a factor. Clamping instead would hand back a wrong number that looks
 * right, which is the one thing an XP formula must not do.
 */
export function applyMultipliers(
  baseXp: number,
  multipliers: readonly Multiplier[],
): number {
  let value = baseXp;
  for (const multiplier of multipliers) {
    assertPermille(multiplier);
    // mulDivFloor: the running value grows with every factor, so a chain of
    // three passes 2^53 from a base a caller could plausibly hand in through
    // the `baseXp` override.
    value = mulDivFloor(value, multiplier.permille, PERMILLE_ONE);
    assertInSafeRange(value, multiplier);
  }
  return value;
}

/** The combined factor of a chain, for reporting. Not used for the arithmetic. */
export function combinedPermille(multipliers: readonly Multiplier[]): number {
  let value = PERMILLE_ONE;
  for (const multiplier of multipliers) {
    assertPermille(multiplier);
    value = mulDivFloor(value, multiplier.permille, PERMILLE_ONE);
    assertInSafeRange(value, multiplier);
  }
  return value;
}

function assertPermille(multiplier: Multiplier): void {
  if (!Number.isSafeInteger(multiplier.permille) || multiplier.permille < 0) {
    throw new ValidationError("Multiplier permille must be a non-negative integer", {
      source: multiplier.source,
      permille: multiplier.permille,
    });
  }
}

function assertInSafeRange(value: number, multiplier: Multiplier): void {
  if (value > MAX_TOTAL_XP || value < MIN_TOTAL_XP) {
    throw new XpOverflowError(
      "Applying this multiplier chain leaves the shared safe integer range",
      { source: multiplier.source, permille: multiplier.permille, value },
    );
  }
}

function remainingInPeriod(
  state: MemberState,
  key: string,
  cap: number,
  periodSeconds: number,
  now: number,
): number {
  const start = state.periodStartAt[key];
  if (start === undefined || now - start >= periodSeconds * 1000) {
    return cap;
  }
  const used = state.periodAwardedXp[key] ?? 0;
  const remaining = cap - used;
  return remaining > 0 ? remaining : 0;
}

function recordInPeriod(
  state: MemberState,
  key: string,
  amount: number,
  periodSeconds: number,
  now: number,
): void {
  const start = state.periodStartAt[key];
  if (start === undefined || now - start >= periodSeconds * 1000) {
    state.periodStartAt[key] = now;
    state.periodAwardedXp[key] = amount;
    return;
  }
  state.periodAwardedXp[key] = (state.periodAwardedXp[key] ?? 0) + amount;
}

/**
 * The point in time from which decay is charged.
 *
 * The grace period is measured from the member's last paying event, *not*
 * from the last decay run — otherwise every run would push the grace period
 * forward again and running decay daily would cost less than running it once
 * a month. Past that point, the last decay run takes over as the anchor, so
 * no period is ever charged twice.
 */
function decayStartAt(state: MemberState, rule: DecayRule, now: number): number {
  const stamps = Object.values(state.lastEventAt);
  if (stamps.length > 0) {
    const graceEnd = Math.max(...stamps) + rule.graceSeconds * 1000;
    return state.lastDecayAt === null ? graceEnd : Math.max(state.lastDecayAt, graceEnd);
  }

  // No recorded activity at all. There is no grace period to serve: the grace
  // exists to protect a member who *was* active, and nothing here says anybody
  // was. Until 2.0.0 this branch used `lastDecayAt` as the last activity and
  // then added the grace to it, so every run pushed the window forward again -
  // the exact failure the comment above says this function prevents. A member
  // who has never been decayed is anchored at `now`, so the first run starts
  // the clock rather than charging for all of history.
  return state.lastDecayAt ?? now;
}

function assertTimestamp(now: number): void {
  // An integer, not merely finite. The Python edition has always required one,
  // and two editions that accept different inputs are two editions somebody
  // will eventually change in one place only.
  if (!Number.isSafeInteger(now)) {
    throw new ValidationError("now must be an epoch-millisecond timestamp as an integer", {
      now,
    });
  }
}

function freezeConfig(input: RankConfigInput): RankConfig {
  const curve = input.curve ?? defaultCurve();
  if (!(curve instanceof Curve)) {
    throw new ConfigurationError("curve must be a Curve instance", {});
  }

  const rules = new Map<string, EventRule>();
  for (const rule of input.rules ?? []) {
    // Validated unconditionally, not only when the object "looks loose".
    // Until 2.0.0 a shape heuristic decided this, so a hand-written object that
    // happened to carry all seven fields skipped every check - and a rule with
    // a fractional minXp or the reserved `*` event type went straight through.
    // createEventRule is idempotent and runs once, at construction.
    const normalised = createEventRule(rule);
    if (rules.has(normalised.eventType)) {
      throw new ConfigurationError("Duplicate event type in rule set", {
        eventType: normalised.eventType,
      });
    }
    rules.set(normalised.eventType, normalised);
  }

  const defaultRuleInput = input.defaultRule ?? null;
  const defaultRule = defaultRuleInput === null ? null : createEventRule(defaultRuleInput);

  const globalCap = input.globalCap ?? null;
  if (globalCap !== null) {
    if (!Number.isSafeInteger(globalCap.xp) || globalCap.xp < 0) {
      throw new ConfigurationError("globalCap.xp must be a non-negative integer", {
        xp: globalCap.xp,
      });
    }
    if (!Number.isSafeInteger(globalCap.periodSeconds) || globalCap.periodSeconds <= 0) {
      throw new ConfigurationError("globalCap.periodSeconds must be positive", {
        periodSeconds: globalCap.periodSeconds,
      });
    }
  }

  const decay = input.decay ?? null;
  if (decay !== null) {
    if (!Number.isSafeInteger(decay.xpPerPeriod) || decay.xpPerPeriod < 0) {
      throw new ConfigurationError("decay.xpPerPeriod must be a non-negative integer", {
        xpPerPeriod: decay.xpPerPeriod,
      });
    }
    if (!Number.isSafeInteger(decay.periodSeconds) || decay.periodSeconds <= 0) {
      throw new ConfigurationError("decay.periodSeconds must be positive", {
        periodSeconds: decay.periodSeconds,
      });
    }
    if (!Number.isSafeInteger(decay.floorXp)) {
      throw new ConfigurationError("decay.floorXp must be an integer", {
        floorXp: decay.floorXp,
      });
    }
    if (!Number.isSafeInteger(decay.graceSeconds) || decay.graceSeconds < 0) {
      throw new ConfigurationError("decay.graceSeconds must be a non-negative integer", {
        graceSeconds: decay.graceSeconds,
      });
    }
  }

  const maxTotalXp = Math.min(input.maxTotalXp ?? MAX_TOTAL_XP, MAX_TOTAL_XP);
  if (!Number.isSafeInteger(maxTotalXp) || maxTotalXp <= 0) {
    throw new ConfigurationError("maxTotalXp must be a positive safe integer", {
      maxTotalXp,
    });
  }

  return Object.freeze({
    curve,
    rules,
    defaultRule,
    globalCap,
    decay,
    allowNegative: input.allowNegative ?? false,
    maxTotalXp,
  });
}

export { createMemberState };
export type { DecayRule, GlobalCap };
