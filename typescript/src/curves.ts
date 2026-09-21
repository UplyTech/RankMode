import {
  DEFAULT_MAX_LEVEL,
  MAX_SUPPORTED_LEVEL,
  MAX_TOTAL_XP,
} from "./constants.js";
import {
  ConfigurationError,
  CurveError,
  ValidationError,
  XpOverflowError,
} from "./errors.js";
import { mulDivFloor, mulExact } from "./exact.js";
import type { LevelProgress } from "./types.js";

/**
 * A curve maps totals onto levels.
 *
 * Every curve materialises a threshold table at construction:
 * `thresholds[L]` is the total needed to reach level `L`, and `thresholds[0]`
 * is always `0`. Working from a table rather than from a closed-form formula
 * is a deliberate choice: it is the only way to guarantee that the Python and
 * the TypeScript edition answer identically for every input, including the
 * awkward ones near the top of the curve.
 */
export abstract class Curve {
  /** `thresholds[L]` = total needed to hold level `L`. Ascending, starts at 0. */
  public readonly thresholds: readonly number[];
  /** Highest level in the table. */
  public readonly maxLevel: number;
  /** Stable name, used in serialised form and in migration reports. */
  public abstract readonly kind: string;

  protected constructor(thresholds: readonly number[]) {
    if (thresholds.length === 0 || thresholds[0] !== 0) {
      throw new ConfigurationError("A curve must start with threshold 0 for level 0", {
        first: thresholds[0],
      });
    }
    // At least level 0 and level 1. A generated curve whose `base` is so large
    // that even the first threshold leaves the safe range used to truncate to a
    // single entry - a curve nobody can ever level up in, reported as if it were
    // fine. TabularCurve has always refused it; now every shape does.
    if (thresholds.length < 2) {
      throw new ConfigurationError(
        "A curve needs at least level 0 and level 1; check that base is not too large",
        { maxLevel: thresholds.length - 1 },
      );
    }
    for (let i = 1; i < thresholds.length; i += 1) {
      const previous = thresholds[i - 1] as number;
      const current = thresholds[i] as number;
      if (!Number.isSafeInteger(current)) {
        throw new ConfigurationError("Curve thresholds must be safe integers", {
          level: i,
          value: current,
        });
      }
      if (current <= previous) {
        throw new ConfigurationError("Curve thresholds must ascend strictly", {
          level: i,
          previous,
          current,
        });
      }
    }
    this.thresholds = Object.freeze([...thresholds]);
    this.maxLevel = thresholds.length - 1;
  }

  /** Total needed to reach `level`. */
  public totalXpForLevel(level: number): number {
    if (!Number.isInteger(level) || level < 0) {
      throw new ValidationError("Level must be a non-negative integer", { level });
    }
    if (level > this.maxLevel) {
      throw new CurveError("Level is above the top of this curve", {
        level,
        maxLevel: this.maxLevel,
      });
    }
    return this.thresholds[level] as number;
  }

  /** XP needed to get from `level` to `level + 1`. */
  public xpForNextLevel(level: number): number {
    if (level <= 0) {
      return this.totalXpForLevel(1);
    }
    if (level >= this.maxLevel) {
      throw new CurveError("There is no level above the top of this curve", {
        level,
        maxLevel: this.maxLevel,
      });
    }
    return this.totalXpForLevel(level + 1) - this.totalXpForLevel(level);
  }

  /** Highest level whose threshold is at or below `totalXp`. */
  public levelForTotalXp(totalXp: number): number {
    // An integer inside the shared safe range, matching the Python edition.
    // Until 2.0.0 this accepted any finite number, so `levelForTotalXp(150.5)`
    // answered here and raised there.
    if (!Number.isSafeInteger(totalXp)) {
      throw new ValidationError("Total XP must be an integer", { totalXp });
    }
    if (totalXp <= 0) {
      return 0;
    }
    const top = this.thresholds[this.maxLevel] as number;
    if (totalXp >= top) {
      return this.maxLevel;
    }
    // Binary search for the last threshold <= totalXp.
    let low = 0;
    let high = this.maxLevel;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if ((this.thresholds[mid] as number) <= totalXp) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }

  /**
   * Full progress information for a total.
   *
   * Throws {@link XpOverflowError} when a *reported* value would leave the
   * shared safe range. The totals themselves always fit — the constants make
   * sure of that — but `xpToNext` is `nextThreshold - totalXp`, and a deeply
   * negative total turns that difference into a number Python can hold and
   * JavaScript cannot. Unreachable for any total of zero or above, which is
   * every total unless `allowNegative` is switched on.
   */
  public progressForTotalXp(totalXp: number): LevelProgress {
    const level = this.levelForTotalXp(totalXp);
    const currentThreshold = this.thresholds[level] as number;
    const isMaxLevel = level >= this.maxLevel;
    const nextThreshold = isMaxLevel ? null : (this.thresholds[level + 1] as number);
    const xpIntoLevel = totalXp - currentThreshold;
    const levelSpan = nextThreshold === null ? null : nextThreshold - currentThreshold;
    const xpToNext = nextThreshold === null ? null : nextThreshold - totalXp;

    if (!Number.isSafeInteger(xpIntoLevel) || (xpToNext !== null && !Number.isSafeInteger(xpToNext))) {
      throw new XpOverflowError(
        "This total is so far below the curve that its progress cannot be reported in both editions",
        { totalXp, currentThreshold, nextThreshold },
      );
    }

    let progressPermille: number;
    if (levelSpan === null) {
      progressPermille = 1000;
    } else if (xpIntoLevel <= 0) {
      progressPermille = 0;
    } else {
      // mulDivFloor rather than the arithmetic written out: `xpIntoLevel * 1000`
      // passes 2^53 for any level wider than about 9e12, which a TabularCurve
      // can be asked for directly.
      progressPermille = mulDivFloor(xpIntoLevel, 1000, levelSpan);
      if (progressPermille > 1000) {
        progressPermille = 1000;
      }
    }

    return {
      level,
      totalXp,
      currentThreshold,
      nextThreshold,
      xpIntoLevel,
      xpToNext,
      levelSpan,
      progressPermille,
      progressRatio: progressPermille / 1000,
      isMaxLevel,
    };
  }

  /** Serialise to a plain object. Round-trips through {@link createCurve}. */
  public toJSON(): CurveSpec {
    return { kind: "tabular", thresholds: [...this.thresholds] };
  }
}

/**
 * Every level costs the same.
 *
 * Suitable for small servers and short-lived scopes. Not suitable for a
 * community that runs for years: newcomers catch up with long-standing
 * members far too easily, which devalues the whole leaderboard.
 */
export class LinearCurve extends Curve {
  public readonly kind = "linear";
  public readonly base: number;

  constructor(options: { base?: number; maxLevel?: number } = {}) {
    const base = options.base ?? 100;
    const maxLevel = normaliseMaxLevel(options.maxLevel);
    assertPositiveInteger(base, "base");
    const thresholds: number[] = [];
    for (let level = 0; level <= maxLevel; level += 1) {
      // mulExact rather than `base * level`: with a large base the product is
      // rounded before the ceiling below ever sees it, and the table would then
      // be built from a number that is not the one Python computed.
      const total = mulExact(base, level);
      if (total === null || total > MAX_TOTAL_XP) {
        break;
      }
      thresholds.push(total);
    }
    super(thresholds);
    this.base = base;
  }

  public override toJSON(): CurveSpec {
    return { kind: "linear", base: this.base, maxLevel: this.maxLevel };
  }
}

/**
 * The cost of a level grows by a constant amount per level.
 *
 * `total(L) = base * L * (L + 1) / 2` — the triangular numbers. Level 1 costs
 * `base`, level 2 costs `2 * base`, and so on, so the *total* grows
 * quadratically while the step from one level to the next grows evenly.
 *
 * This is the default, and the concept explains why: linear devalues
 * long-standing members, exponential frustrates newcomers early. Quadratic
 * keeps both in a workable relation.
 */
export class QuadraticCurve extends Curve {
  public readonly kind = "quadratic";
  public readonly base: number;

  constructor(options: { base?: number; maxLevel?: number } = {}) {
    const base = options.base ?? 100;
    const maxLevel = normaliseMaxLevel(options.maxLevel);
    assertPositiveInteger(base, "base");
    const thresholds: number[] = [];
    for (let level = 0; level <= maxLevel; level += 1) {
      // level * (level + 1) is always even, so the halving is exact. The
      // multiplication is not: `base * level` alone can pass 2^53, and it does
      // so *before* the ceiling below can reject it. Splitting the expression
      // keeps every step exact, which is what makes this table the same table
      // the Python edition builds.
      const cost = mulExact(base, level);
      if (cost === null) {
        // `total` is at least `cost` for every level above 0, so a cost that
        // cannot be held cannot produce a total that can.
        break;
      }
      const total = mulDivFloor(cost, level + 1, 2);
      if (total > MAX_TOTAL_XP) {
        break;
      }
      thresholds.push(total);
    }
    super(thresholds);
    this.base = base;
  }

  public override toJSON(): CurveSpec {
    return { kind: "quadratic", base: this.base, maxLevel: this.maxLevel };
  }
}

/**
 * The cost of a level is multiplied by a constant factor each level.
 *
 * The factor is given in permille — `1500` means each level costs 1.5x the
 * previous one — and every step uses integer floor division, so both editions
 * produce the same table. The table stops as soon as the next total would
 * leave the safe range, which is why an exponential curve usually has a much
 * lower `maxLevel` than the one that was asked for.
 */
export class ExponentialCurve extends Curve {
  public readonly kind = "exponential";
  public readonly base: number;
  public readonly growthPermille: number;

  constructor(
    options: { base?: number; growthPermille?: number; maxLevel?: number } = {},
  ) {
    const base = options.base ?? 100;
    const growthPermille = options.growthPermille ?? 1500;
    const maxLevel = normaliseMaxLevel(options.maxLevel);
    assertPositiveInteger(base, "base");
    if (!Number.isInteger(growthPermille) || growthPermille <= 1000) {
      throw new ConfigurationError(
        "growthPermille must be an integer above 1000 (= factor 1.0)",
        { growthPermille },
      );
    }

    const thresholds: number[] = [0];
    let cost = base;
    let total = 0;
    for (let level = 1; level <= maxLevel; level += 1) {
      if (total + cost > MAX_TOTAL_XP) {
        break;
      }
      total += cost;
      thresholds.push(total);
      const next = mulDivFloor(cost, growthPermille, 1000);
      cost = next > cost ? next : cost + 1;
    }
    super(thresholds);
    this.base = base;
    this.growthPermille = growthPermille;
  }

  public override toJSON(): CurveSpec {
    return {
      kind: "exponential",
      base: this.base,
      growthPermille: this.growthPermille,
      maxLevel: this.maxLevel,
    };
  }
}

/**
 * Thresholds supplied verbatim by the operator.
 *
 * For the cases the three generated shapes do not cover — a season pass, a
 * hand-tuned table inherited from an older bot, a curve that flattens out on
 * purpose.
 */
export class TabularCurve extends Curve {
  public readonly kind = "tabular";

  constructor(thresholds: readonly number[]) {
    if (thresholds.length < 2) {
      throw new ConfigurationError(
        "A tabular curve needs at least level 0 and level 1",
        { length: thresholds.length },
      );
    }
    if (thresholds.length - 1 > MAX_SUPPORTED_LEVEL) {
      throw new ConfigurationError("Tabular curve exceeds the supported level range", {
        maxLevel: thresholds.length - 1,
        supported: MAX_SUPPORTED_LEVEL,
      });
    }
    super(thresholds);
  }
}

/** Serialised form of a curve. */
export type CurveSpec =
  | { kind: "linear"; base?: number; maxLevel?: number }
  | { kind: "quadratic"; base?: number; maxLevel?: number }
  | {
      kind: "exponential";
      base?: number;
      growthPermille?: number;
      maxLevel?: number;
    }
  | { kind: "tabular"; thresholds: readonly number[] };

/** Build a curve from its serialised form. */
export function createCurve(spec: CurveSpec): Curve {
  switch (spec.kind) {
    case "linear":
      return new LinearCurve(spec);
    case "quadratic":
      return new QuadraticCurve(spec);
    case "exponential":
      return new ExponentialCurve(spec);
    case "tabular":
      return new TabularCurve(spec.thresholds);
    default: {
      const unknown = spec as { kind?: unknown };
      throw new ConfigurationError("Unknown curve kind", { kind: unknown.kind });
    }
  }
}

/** The curve RankMode uses when the caller does not choose one. */
export function defaultCurve(): Curve {
  return new QuadraticCurve();
}

function normaliseMaxLevel(maxLevel: number | undefined): number {
  const value = maxLevel ?? DEFAULT_MAX_LEVEL;
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationError("maxLevel must be an integer of at least 1", {
      maxLevel: value,
    });
  }
  if (value > MAX_SUPPORTED_LEVEL) {
    throw new ConfigurationError("maxLevel exceeds the supported level range", {
      maxLevel: value,
      supported: MAX_SUPPORTED_LEVEL,
    });
  }
  return value;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationError(`${name} must be an integer of at least 1`, {
      [name]: value,
    });
  }
}
