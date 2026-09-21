import { describe, it, expect } from "vitest";
import {
  AwardOutcome,
  cloneMemberState,
  createEventRule,
  createMemberState,
  deserializeMemberState,
  pruneMemberState,
  QuadraticCurve,
  RankEngine,
  serializeMemberState,
  ValidationError,
} from "../src/index.js";

const T0 = 1_700_000_000_000;

describe("createMemberState", () => {
  it("starts empty", () => {
    const state = createMemberState();
    expect(state.totalXp).toBe(0);
    expect(state.lastEventAt).toEqual({});
    expect(state.lastDecayAt).toBeNull();
  });

  it("can start from an existing total", () => {
    expect(createMemberState(1234).totalXp).toBe(1234);
  });

  it("refuses a total outside the safe range", () => {
    expect(() => createMemberState(1.5)).toThrow(ValidationError);
    expect(() => createMemberState(Number.MAX_SAFE_INTEGER + 10)).toThrow(ValidationError);
  });
});

describe("cloneMemberState", () => {
  it("copies the maps rather than sharing them", () => {
    const state = createMemberState(10);
    state.lastEventAt["message"] = T0;
    const copy = cloneMemberState(state);
    copy.lastEventAt["message"] = 0;
    expect(state.lastEventAt["message"]).toBe(T0);
  });
});

describe("serialization", () => {
  it("round-trips through JSON", () => {
    const engine = new RankEngine({
      curve: new QuadraticCurve({ base: 100, maxLevel: 10 }),
      rules: [createEventRule({ eventType: "message", minXp: 10, cooldownSeconds: 60, periodCapXp: 100 })],
    });
    const awarded = engine.award(createMemberState(), "message", { now: T0 });

    const stored = JSON.stringify(serializeMemberState(awarded.state));
    const restored = deserializeMemberState(JSON.parse(stored));

    expect(restored).toEqual(awarded.state);
    const next = engine.award(restored, "message", { now: T0 + 1000 });
    expect(next.outcome).toBe(AwardOutcome.Cooldown);
  });

  it("fills in fields a older caller did not store", () => {
    const restored = deserializeMemberState({ totalXp: 500 });
    expect(restored.totalXp).toBe(500);
    expect(restored.lastEventAt).toEqual({});
    expect(restored.periodStartAt).toEqual({});
    expect(restored.periodAwardedXp).toEqual({});
    expect(restored.lastDecayAt).toBeNull();
  });

  it("defaults an entirely empty row to a fresh member", () => {
    expect(deserializeMemberState({}).totalXp).toBe(0);
  });

  it("rejects data it cannot trust", () => {
    expect(() => deserializeMemberState(null)).toThrow(ValidationError);
    expect(() => deserializeMemberState("nope")).toThrow(ValidationError);
    expect(() => deserializeMemberState({ totalXp: "500" })).toThrow(ValidationError);
    expect(() => deserializeMemberState({ totalXp: 1.5 })).toThrow(ValidationError);
    expect(() => deserializeMemberState({ lastEventAt: 5 })).toThrow(ValidationError);
    expect(() => deserializeMemberState({ lastEventAt: { a: "x" } })).toThrow(ValidationError);
    expect(() => deserializeMemberState({ lastDecayAt: "now" })).toThrow(ValidationError);
  });

  it("accepts an explicit null lastDecayAt", () => {
    expect(deserializeMemberState({ totalXp: 1, lastDecayAt: null }).lastDecayAt).toBeNull();
  });
});

describe("pruneMemberState", () => {
  it("drops cooldown stamps that can no longer block anything", () => {
    const state = createMemberState(100);
    state.lastEventAt["message"] = T0 - 10 * 60_000;
    state.lastEventAt["reaction"] = T0 - 1_000;

    const pruned = pruneMemberState(state, { now: T0, keepCooldownMs: 60_000 });
    expect(pruned.lastEventAt["message"]).toBeUndefined();
    expect(pruned.lastEventAt["reaction"]).toBe(T0 - 1_000);
    expect(pruned.totalXp).toBe(100);
  });

  it("leaves the original untouched", () => {
    const state = createMemberState(100);
    state.lastEventAt["message"] = T0 - 10 * 60_000;
    pruneMemberState(state, { now: T0 });
    expect(state.lastEventAt["message"]).toBeDefined();
  });
});
