/**
 * Deterministic fixed-point arithmetic.
 *
 * The foundation the whole ranked half stands on. A rating system needs `exp`,
 * `ln` and `sqrt`, and the reason they are written out here rather than taken
 * from the runtime is that IEEE 754 pins down the four basic operations to the
 * last bit and does *not* pin down the transcendental ones. Two runtimes are
 * free to disagree by one unit in the last place, and a rating one micro-unit
 * either side of a promotion threshold is a player promoted in one edition and
 * not the other.
 *
 * These mirror `python/tests/test_fixed.py` test for test.
 */
import { describe, expect, it } from "vitest";

import {
  fixedDiv,
  fixedExp,
  fixedLn,
  fixedMul,
  fixedSqrt,
  fromFixed,
  isqrt,
  SCALE,
  toFixed,
  ValidationError,
} from "../src/index.js";

describe("conversion", () => {
  it("scales by a million", () => {
    expect(toFixed(1)).toBe(1_000_000);
    expect(toFixed(0)).toBe(0);
    expect(toFixed(-3)).toBe(-3_000_000);
  });

  it("rounds half away from zero", () => {
    const cases: [number, number][] = [
      [1_000_000, 1],
      [1_499_999, 1],
      [1_500_000, 2],
      [2_500_000, 3],
      [-1_500_000, -2],
      [-2_500_000, -3],
      [0, 0],
      [499_999, 0],
      [500_000, 1],
    ];
    for (const [value, expected] of cases) {
      expect(fromFixed(value)).toBe(expected);
    }
  });

  it("rounds symmetrically about zero", () => {
    // Half-to-even would make x.5 round differently depending on whether x is
    // odd, which is impossible to explain to a player on a promotion threshold.
    // Stated as a sum rather than as `a === -b`, because negating a zero is
    // how JavaScript produces `-0` and the assertion would then be testing the
    // test rather than the function.
    for (let magnitude = 0; magnitude < 20_000_000; magnitude += 500_000) {
      expect(fromFixed(magnitude) + fromFixed(-magnitude)).toBe(0);
      expect(Math.abs(fromFixed(magnitude))).toBe(Math.abs(fromFixed(-magnitude)));
    }
  });

  it("round trips whole numbers", () => {
    for (let value = -5000; value <= 5000; value += 37) {
      expect(fromFixed(toFixed(value))).toBe(value);
    }
  });
});

describe("isqrt", () => {
  it("handles small values", () => {
    const cases: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [8, 2],
      [9, 3],
    ];
    for (const [value, expected] of cases) {
      expect(isqrt(value)).toBe(expected);
    }
  });

  it("is the floor of the real root", () => {
    for (let value = 0; value < 100_000; value += 149) {
      const root = isqrt(value);
      expect(root * root).toBeLessThanOrEqual(value);
      expect(value).toBeLessThan((root + 1) * (root + 1));
    }
  });

  it("is exact far past double precision", () => {
    // The reason it is written on BigInt: 10^18 is well past where a double is
    // exact, and the answer must be the integer root, not an approximation.
    expect(isqrt(10n ** 18n)).toBe(10 ** 9);
    expect(isqrt(10n ** 18n - 1n)).toBe(10 ** 9 - 1);
    const big = 2n ** 53n + 1n;
    expect(isqrt(big * big)).toBe(Number(big));
  });

  it("refuses a negative", () => {
    expect(() => isqrt(-1)).toThrow(ValidationError);
  });
});

describe("multiplication and division", () => {
  it("multiplies", () => {
    expect(fixedMul(toFixed(3), toFixed(4))).toBe(toFixed(12));
    expect(fixedMul(500_000, 500_000)).toBe(250_000);
  });

  it("divides", () => {
    expect(fixedDiv(toFixed(12), toFixed(4))).toBe(toFixed(3));
    expect(fixedDiv(SCALE, 3 * SCALE)).toBe(333_333);
  });

  it("rounds half away from zero", () => {
    expect(fixedMul(1, 500_000)).toBe(1);
    expect(fixedMul(-1, 500_000)).toBe(-1);
  });

  it("gets the signs right", () => {
    expect(fixedMul(toFixed(-3), toFixed(4))).toBe(toFixed(-12));
    expect(fixedMul(toFixed(-3), toFixed(-4))).toBe(toFixed(12));
    expect(fixedDiv(toFixed(-12), toFixed(4))).toBe(toFixed(-3));
    expect(fixedDiv(toFixed(-12), toFixed(-4))).toBe(toFixed(3));
  });

  it("treats division by zero as an error rather than Infinity", () => {
    expect(() => fixedDiv(SCALE, 0)).toThrow(ValidationError);
  });

  it("keeps intermediates beyond a double exact", () => {
    // a * b overflows 2^53 long before either operand does. This is the hazard
    // the 2.0.0 release was cut for, in its fixed-point form.
    const big = 3_000_000_000;
    expect(fixedMul(big, big)).toBe(Number((BigInt(big) * BigInt(big)) / BigInt(SCALE)));
  });
});

describe("fixedSqrt", () => {
  it("matches Math.sqrt to half a micro-unit", () => {
    for (const value of [0, 1, 2, 4, 9, 100, 1234, 999_999]) {
      const got = fixedSqrt(toFixed(value));
      expect(Math.abs(got - Math.sqrt(value) * SCALE)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  it("of one is one, of zero is zero", () => {
    expect(fixedSqrt(SCALE)).toBe(SCALE);
    expect(fixedSqrt(0)).toBe(0);
  });

  it("refuses a negative", () => {
    expect(() => fixedSqrt(-1)).toThrow(ValidationError);
  });

  it("is monotone", () => {
    let previous = -1;
    for (let value = 0; value < 20_000_000; value += 7919) {
      const current = fixedSqrt(value);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("fixedLn", () => {
  it("of one is zero", () => {
    expect(fixedLn(SCALE)).toBe(0);
  });

  it("matches Math.log to a micro-unit", () => {
    for (const value of [1, 2, 3, 7, 10, 100, 1000, 2718, 100_000]) {
      const got = fixedLn(toFixed(value));
      expect(Math.abs(got - Math.log(value) * SCALE)).toBeLessThanOrEqual(1.0);
    }
  });

  it("handles values below one", () => {
    for (const numerator of [1, 10, 100, 500, 999_999]) {
      const got = fixedLn(numerator);
      expect(Math.abs(got - Math.log(numerator / SCALE) * SCALE)).toBeLessThanOrEqual(1.5);
    }
  });

  it("refuses zero and negatives", () => {
    expect(() => fixedLn(0)).toThrow(ValidationError);
    expect(() => fixedLn(-SCALE)).toThrow(ValidationError);
  });

  it("is increasing", () => {
    let previous = fixedLn(1);
    for (let value = 1000; value < 5_000_000; value += 4001) {
      const current = fixedLn(value);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("fixedExp", () => {
  it("of zero is one", () => {
    expect(fixedExp(0)).toBe(SCALE);
  });

  it("matches Math.exp", () => {
    for (const value of [-20, -10, -5, -1, 0, 1, 2, 5, 10, 15, 20]) {
      const got = fixedExp(toFixed(value));
      const want = Math.exp(value) * SCALE;
      // Relative rather than absolute: e^20 is half a billion, and one
      // micro-unit of it is not a meaningful tolerance.
      expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.max(1.0, Math.abs(want) * 1e-6));
    }
  });

  it("handles fractional arguments", () => {
    for (let micro = -2_000_000; micro <= 2_000_000; micro += 41_137) {
      const got = fixedExp(micro);
      const want = Math.exp(micro / SCALE) * SCALE;
      expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.max(1.0, Math.abs(want) * 1e-6));
    }
  });

  it("refuses arguments outside plus or minus twenty", () => {
    // Two limits meet at 20: e^20 is half a billion, and e^-20 is two
    // billionths, which micro-units cannot represent at all.
    expect(() => fixedExp(toFixed(21))).toThrow(ValidationError);
    expect(() => fixedExp(toFixed(-21))).toThrow(ValidationError);
    expect(fixedExp(toFixed(20))).toBeGreaterThan(0);
    expect(fixedExp(toFixed(-20))).toBeGreaterThanOrEqual(0);
  });

  it("is the inverse of ln", () => {
    for (let value = 1; value < 5000; value += 97) {
      const recovered = fixedExp(fixedLn(toFixed(value)));
      const tolerance = Math.max(2, Math.floor(toFixed(value) / 100_000));
      expect(Math.abs(recovered - toFixed(value))).toBeLessThanOrEqual(tolerance);
    }
  });

  it("is increasing", () => {
    let previous = -1;
    for (let micro = -20_000_000; micro <= 20_000_000; micro += 313_337) {
      const current = fixedExp(micro);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("determinism", () => {
  it("gives identical answers on repeated calls", () => {
    for (let micro = 1; micro < 10_000_000; micro += 173_717) {
      expect(fixedLn(micro)).toBe(fixedLn(micro));
      expect(fixedSqrt(micro)).toBe(fixedSqrt(micro));
    }
    for (let micro = -10_000_000; micro <= 10_000_000; micro += 421_337) {
      expect(fixedExp(micro)).toBe(fixedExp(micro));
    }
  });

  it("never lets a float leak into a result", () => {
    // A single float anywhere in the chain would make the two editions
    // disagree, and it would show up as a non-integer return.
    for (const value of [
      fixedLn(1_234_567),
      fixedExp(1_234_567),
      fixedSqrt(1_234_567),
      fixedMul(1_234_567, 7_654_321),
      fixedDiv(1_234_567, 7_654_321),
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });
});

describe("negative zero", () => {
  it("never comes back from fromFixed", () => {
    // `-0` is a value JavaScript has and Python does not. `fromFixed(-1)`
    // negates a floor of zero and used to produce it, which would be a number
    // the two editions spell differently.
    for (const value of [-1, -499_999, -500_000 + 1, 0, -0]) {
      expect(Object.is(fromFixed(value), -0)).toBe(false);
    }
    expect(Object.is(toFixed(-0), -0)).toBe(false);
  });
});
