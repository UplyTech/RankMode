import { describe, it, expect } from "vitest";
import {
  CryptoRandomSource,
  FixedRandomSource,
  SeededRandomSource,
  ValidationError,
} from "../src/index.js";

describe("CryptoRandomSource", () => {
  const source = new CryptoRandomSource();

  it("stays inside the requested span", () => {
    for (let i = 0; i < 500; i += 1) {
      const value = source.randomInt(15, 25);
      expect(value).toBeGreaterThanOrEqual(15);
      expect(value).toBeLessThanOrEqual(25);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("includes both ends of the span", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(source.randomInt(0, 2));
    }
    expect(seen).toEqual(new Set([0, 1, 2]));
  });

  it("returns the value itself for a span of one", () => {
    expect(source.randomInt(7, 7)).toBe(7);
  });

  it("rejects an inverted or fractional span", () => {
    expect(() => source.randomInt(10, 5)).toThrow(ValidationError);
    expect(() => source.randomInt(1.5, 5)).toThrow(ValidationError);
  });
});

describe("SeededRandomSource", () => {
  it("produces the same sequence for the same seed", () => {
    const a = new SeededRandomSource(42);
    const b = new SeededRandomSource(42);
    for (let i = 0; i < 50; i += 1) {
      expect(a.randomInt(0, 1000)).toBe(b.randomInt(0, 1000));
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = new SeededRandomSource(1);
    const b = new SeededRandomSource(2);
    const left = Array.from({ length: 20 }, () => a.randomInt(0, 1_000_000));
    const right = Array.from({ length: 20 }, () => b.randomInt(0, 1_000_000));
    expect(left).not.toEqual(right);
  });

  it("stays inside the span", () => {
    const source = new SeededRandomSource(99);
    for (let i = 0; i < 1000; i += 1) {
      const value = source.randomInt(15, 25);
      expect(value).toBeGreaterThanOrEqual(15);
      expect(value).toBeLessThanOrEqual(25);
    }
  });

  it("exposes its raw output so the editions can be compared", () => {
    const source = new SeededRandomSource(0);
    const first = source.next32();
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(0xffffffff);
  });

  it("rejects a fractional seed", () => {
    expect(() => new SeededRandomSource(1.5)).toThrow(ValidationError);
  });
});

describe("FixedRandomSource", () => {
  it("replays its values in order", () => {
    const source = new FixedRandomSource([1, 2, 3]);
    expect(source.randomInt(0, 10)).toBe(1);
    expect(source.randomInt(0, 10)).toBe(2);
    expect(source.randomInt(0, 10)).toBe(3);
    expect(source.consumed).toBe(3);
  });

  it("cycles by default", () => {
    const source = new FixedRandomSource([1, 2]);
    expect([
      source.randomInt(0, 10),
      source.randomInt(0, 10),
      source.randomInt(0, 10),
    ]).toEqual([1, 2, 1]);
  });

  it("can refuse to cycle", () => {
    const source = new FixedRandomSource([1], { cycle: false });
    source.randomInt(0, 10);
    expect(() => source.randomInt(0, 10)).toThrow(ValidationError);
  });

  it("clamps a value the rule would not allow", () => {
    const source = new FixedRandomSource([0, 999]);
    expect(source.randomInt(15, 25)).toBe(15);
    expect(source.randomInt(15, 25)).toBe(25);
  });

  it("can be rewound", () => {
    const source = new FixedRandomSource([5, 6]);
    source.randomInt(0, 10);
    source.reset();
    expect(source.randomInt(0, 10)).toBe(5);
  });

  it("needs at least one value", () => {
    expect(() => new FixedRandomSource([])).toThrow(ValidationError);
  });
});
