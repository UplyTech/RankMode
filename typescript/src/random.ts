import { randomInt } from "node:crypto";
import { ValidationError } from "./errors.js";

/**
 * The source of the random span in an award.
 *
 * Awarding a fixed number of XP per message invites members to work out the
 * exact rate and farm it. A span makes that pointless. A *built-in* random
 * generator, however, would make the whole library untestable — so the source
 * is handed in: the real one in production, a predictable one in tests.
 *
 * In production use {@link CryptoRandomSource}. A predictable generator lets a
 * member who knows the algorithm predict the next award, which is exactly the
 * farming the span was meant to prevent.
 */
export interface RandomSource {
  /** Uniformly distributed integer in `[min, max]`, both inclusive. */
  randomInt(min: number, max: number): number;
}

/** Cryptographically sound source, backed by `node:crypto`. The production default. */
export class CryptoRandomSource implements RandomSource {
  public randomInt(min: number, max: number): number {
    assertRange(min, max);
    if (min === max) {
      return min;
    }
    // node:crypto uses an exclusive upper bound.
    return randomInt(min, max + 1);
  }
}

/**
 * Deterministic source for tests and for reproducing a reported result.
 *
 * The algorithm is mulberry32, chosen because it is short enough to be
 * reimplemented identically in every edition of this library. It is *not*
 * suitable for production: see the note on {@link RandomSource}.
 */
export class SeededRandomSource implements RandomSource {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new ValidationError("Seed must be an integer", { seed });
    }
    this.state = seed >>> 0;
  }

  public randomInt(min: number, max: number): number {
    assertRange(min, max);
    if (min === max) {
      return min;
    }
    const span = max - min + 1;
    return min + (this.next32() % span);
  }

  /** Next raw 32-bit value. Exposed so the editions can be compared directly. */
  public next32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }
}

/**
 * Replays a fixed list of values.
 *
 * This is what the shared test vectors use: it needs no agreement about a
 * pseudo-random algorithm between the editions, only about the values.
 * Out-of-range values are clamped into `[min, max]` so a vector cannot
 * accidentally produce an award the rule does not allow.
 */
export class FixedRandomSource implements RandomSource {
  private readonly values: readonly number[];
  private index = 0;
  private readonly cycle: boolean;

  constructor(values: readonly number[], options: { cycle?: boolean } = {}) {
    if (values.length === 0) {
      throw new ValidationError("FixedRandomSource needs at least one value", {});
    }
    this.values = [...values];
    this.cycle = options.cycle ?? true;
  }

  public randomInt(min: number, max: number): number {
    assertRange(min, max);
    if (this.index >= this.values.length) {
      if (!this.cycle) {
        throw new ValidationError("FixedRandomSource ran out of values", {
          consumed: this.index,
        });
      }
      this.index = 0;
    }
    const value = this.values[this.index] as number;
    this.index += 1;
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  /** How many values have been consumed so far. */
  public get consumed(): number {
    return this.index;
  }

  /** Start again from the first value. */
  public reset(): void {
    this.index = 0;
  }
}

function assertRange(min: number, max: number): void {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new ValidationError("Random bounds must be integers", { min, max });
  }
  if (max < min) {
    throw new ValidationError("Upper random bound is below the lower one", {
      min,
      max,
    });
  }
}
