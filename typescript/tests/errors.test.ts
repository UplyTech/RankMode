import { describe, it, expect } from "vitest";
import {
  ConfigurationError,
  CurveError,
  MigrationError,
  RankModeError,
  ValidationError,
  XpOverflowError,
} from "../src/index.js";

describe("error hierarchy", () => {
  const cases: readonly [new (m: string) => RankModeError, string][] = [
    [ConfigurationError, "CONFIGURATION_ERROR"],
    [ValidationError, "VALIDATION_ERROR"],
    [CurveError, "CURVE_ERROR"],
    [XpOverflowError, "XP_OVERFLOW"],
    [MigrationError, "MIGRATION_ERROR"],
  ];

  it("lets a caller catch everything with one class", () => {
    for (const [Ctor] of cases) {
      const error = new Ctor("boom");
      expect(error).toBeInstanceOf(RankModeError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("carries a stable code so nobody has to compare message texts", () => {
    for (const [Ctor, code] of cases) {
      expect(new Ctor("boom").code).toBe(code);
    }
  });

  it("names itself after its class", () => {
    expect(new ValidationError("boom").name).toBe("ValidationError");
  });

  it("carries structured details", () => {
    const error = new ValidationError("bad total", { totalXp: -5 });
    expect(error.details["totalXp"]).toBe(-5);
  });

  it("freezes the details so a caught error cannot be doctored", () => {
    const error = new ValidationError("bad total", { totalXp: -5 });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("defaults details to an empty object", () => {
    expect(new RankModeError("x", { code: "X" }).details).toEqual({});
  });

  it("keeps a cause when one is given", () => {
    const cause = new Error("root");
    const error = new RankModeError("wrapped", { code: "X", cause });
    expect((error as { cause?: unknown }).cause).toBe(cause);
  });
});
