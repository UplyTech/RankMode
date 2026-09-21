/**
 * The arithmetic helper the whole cross-edition guarantee now rests on.
 *
 * There is no Python counterpart to this file, and there should not be: Python
 * integers are exact at any size, so this module exists purely to give the
 * TypeScript edition the same property. Every expectation below is therefore
 * checked against BigInt, which is what Python's integers behave like — not
 * against the double arithmetic the implementation is replacing.
 */
import { describe, expect, it } from "vitest";

import { mulDivFloor, mulExact } from "../src/exact.js";

const MAX = Number.MAX_SAFE_INTEGER;

describe("mulDivFloor", () => {
  it("agrees with plain arithmetic while the product is small", () => {
    expect(mulDivFloor(20, 1500, 1000)).toBe(30);
    expect(mulDivFloor(7, 1, 2)).toBe(3);
    expect(mulDivFloor(0, 12345, 1000)).toBe(0);
    expect(mulDivFloor(1, 0, 1000)).toBe(0);
  });

  it("floors rather than rounds", () => {
    expect(mulDivFloor(999, 1, 1000)).toBe(0);
    expect(mulDivFloor(1999, 1, 1000)).toBe(1);
  });

  it("stays exact once the product passes 2^53", () => {
    // The four inputs that made ExponentialCurve build a different table in
    // each edition. `cost * growthPermille` is above 2^53 in all of them.
    for (const [a, b, c] of [
      [255666746264386, 1500, 1000],
      [47024517823920, 3000, 1000],
      [2391484340507786, 3000, 1000],
      [147891644013370, 1500, 1000],
    ] as const) {
      expect(BigInt(mulDivFloor(a, b, c))).toBe((BigInt(a) * BigInt(b)) / BigInt(c));
    }
  });

  it("matches BigInt everywhere the answer itself fits", () => {
    // A deterministic sweep rather than a random one: a failing build should
    // fail the same way twice.
    let value = 1;
    let checked = 0;
    for (let step = 0; step < 60; step += 1) {
      value = Math.min(MAX, value * 3 + 7);
      for (const permille of [1, 999, 1000, 1001, 1500, 3000, 48574]) {
        const expected = (BigInt(value) * BigInt(permille)) / 1000n;
        // Above this the answer is not a safe integer, and returning it as a
        // `number` is not something any function could do. The callers that
        // reach it raise XpOverflowError instead - see magnitudes.test.ts.
        if (expected > BigInt(MAX)) {
          continue;
        }
        expect(BigInt(mulDivFloor(value, permille, 1000))).toBe(expected);
        checked += 1;
      }
    }
    // Guards the guard: a `continue` that swallowed everything would leave this
    // test green while asserting nothing.
    expect(checked).toBeGreaterThan(150);
  });

  it("floors toward negative infinity, the way Python's // does", () => {
    // BigInt division truncates toward zero and Python's `//` floors. They
    // differ only for a negative result that does not divide evenly, which no
    // caller in this package produces - but the helper must not be the place
    // where that assumption is silently wrong.
    expect(mulDivFloor(-7, 1, 2)).toBe(-4);
    expect(mulDivFloor(-MAX, 3, 2)).toBe(
      Number((BigInt(-MAX) * 3n) / 2n) - 1,
    );
    expect(mulDivFloor(-8, 1, 2)).toBe(-4);
  });
});

describe("mulExact", () => {
  it("returns the product while it fits", () => {
    expect(mulExact(0, 12345)).toBe(0);
    expect(mulExact(100, 1000)).toBe(100_000);
    expect(mulExact(MAX, 1)).toBe(MAX);
  });

  it("stays exact for a product that a double would round", () => {
    expect(mulExact(9_007_199_254_740, 1000)).toBe(9007199254740000);
  });

  it("returns null rather than a rounded answer", () => {
    expect(mulExact(MAX, 2)).toBeNull();
    expect(mulExact(9_007_199_254_740, 1_000_000)).toBeNull();
    expect(mulExact(-MAX, 2)).toBeNull();
  });

  it("returns null exactly at the boundary, not one step late", () => {
    expect(mulExact(MAX, 1)).toBe(MAX);
    // MAX + 1 is 2^53, the first integer a double cannot hold uniquely.
    expect(mulExact((MAX + 1) / 2, 2)).toBeNull();
  });
});
