import { describe, it, expect } from "vitest";
import {
  applyMultipliers,
  AwardOutcome,
  combinedPermille,
  ConfigurationError,
  createEventRule,
  createMemberState,
  defaultRules,
  FixedRandomSource,
  LinearCurve,
  MAX_TOTAL_XP,
  QuadraticCurve,
  RankEngine,
  TabularCurve,
  ValidationError,
} from "../src/index.js";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function engine(overrides: Parameters<typeof buildEngine>[0] = {}): RankEngine {
  return buildEngine(overrides);
}

function buildEngine(overrides: ConstructorParameters<typeof RankEngine>[0] = {}) {
  return new RankEngine({
    curve: new QuadraticCurve({ base: 100, maxLevel: 50 }),
    rules: [
      createEventRule({
        eventType: "message",
        minXp: 15,
        maxXp: 25,
        cooldownSeconds: 60,
        periodCapXp: 1000,
      }),
    ],
    ...overrides,
  });
}

/** Always rolls the same value, so awards are predictable. */
function fixed(value: number): FixedRandomSource {
  return new FixedRandomSource([value]);
}

describe("award", () => {
  it("grants XP and reports the new level", () => {
    const rank = engine();
    const state = createMemberState();
    const result = rank.award(state, "message", { now: T0, random: fixed(20) });

    expect(result.outcome).toBe(AwardOutcome.Awarded);
    expect(result.awardedXp).toBe(20);
    expect(result.baseXp).toBe(20);
    expect(result.newTotalXp).toBe(20);
    expect(result.previousLevel).toBe(0);
    expect(result.newLevel).toBe(0);
    expect(result.leveledUp).toBe(false);
  });

  it("never mutates the state it was given", () => {
    const rank = engine();
    const state = createMemberState(500);
    const result = rank.award(state, "message", { now: T0, random: fixed(20) });

    expect(state.totalXp).toBe(500);
    expect(state.lastEventAt).toEqual({});
    expect(result.state.totalXp).toBe(520);
    expect(result.state.lastEventAt["message"]).toBe(T0);
  });

  it("reports a level-up exactly once", () => {
    const rank = engine();
    // level 1 starts at 100
    let state = createMemberState(90);
    const first = rank.award(state, "message", { now: T0, random: fixed(20) });
    expect(first.leveledUp).toBe(true);
    expect(first.newLevel).toBe(1);

    state = first.state;
    const second = rank.award(state, "message", {
      now: T0 + 2 * MINUTE,
      random: fixed(20),
    });
    expect(second.leveledUp).toBe(false);
    expect(second.newLevel).toBe(1);
  });

  it("blocks a second award inside the cooldown", () => {
    const rank = engine();
    const first = rank.award(createMemberState(), "message", {
      now: T0,
      random: fixed(20),
    });
    const second = rank.award(first.state, "message", {
      now: T0 + 30_000,
      random: fixed(20),
    });

    expect(second.outcome).toBe(AwardOutcome.Cooldown);
    expect(second.awardedXp).toBe(0);
    expect(second.newTotalXp).toBe(20);
    expect(second.cooldownRemainingMs).toBe(30_000);
  });

  it("does not restart the cooldown when it blocks", () => {
    const rank = engine();
    const first = rank.award(createMemberState(), "message", {
      now: T0,
      random: fixed(20),
    });
    const blocked = rank.award(first.state, "message", {
      now: T0 + 30_000,
      random: fixed(20),
    });
    // Without the "no restart" rule, spamming would keep the cooldown alive forever.
    const third = rank.award(blocked.state, "message", {
      now: T0 + 61_000,
      random: fixed(20),
    });
    expect(third.outcome).toBe(AwardOutcome.Awarded);
  });

  it("lets the cooldown expire exactly on the boundary", () => {
    const rank = engine();
    const first = rank.award(createMemberState(), "message", {
      now: T0,
      random: fixed(20),
    });
    const onBoundary = rank.award(first.state, "message", {
      now: T0 + 60_000,
      random: fixed(20),
    });
    expect(onBoundary.outcome).toBe(AwardOutcome.Awarded);
  });

  it("returns UNKNOWN_EVENT rather than throwing", () => {
    const rank = engine();
    const result = rank.award(createMemberState(), "sacrifice", { now: T0 });
    expect(result.outcome).toBe(AwardOutcome.UnknownEvent);
    expect(result.rule).toBeNull();
    expect(result.awardedXp).toBe(0);
  });

  it("falls back to the default rule for unknown event types", () => {
    const rank = engine({
      defaultRule: createEventRule({ eventType: "any", minXp: 5, maxXp: 5 }),
    });
    const result = rank.award(createMemberState(), "something-else", { now: T0 });
    expect(result.outcome).toBe(AwardOutcome.Awarded);
    expect(result.awardedXp).toBe(5);
  });

  it("reports a disabled rule", () => {
    const rank = engine({
      rules: [createEventRule({ eventType: "message", minXp: 10, enabled: false })],
    });
    const result = rank.award(createMemberState(), "message", { now: T0 });
    expect(result.outcome).toBe(AwardOutcome.RuleDisabled);
  });

  it("skips the random source when the span is a single value", () => {
    const rank = engine({
      rules: [createEventRule({ eventType: "message", minXp: 7, maxXp: 7 })],
    });
    const source = new FixedRandomSource([99]);
    const result = rank.award(createMemberState(), "message", { now: T0, random: source });
    expect(result.awardedXp).toBe(7);
    expect(source.consumed).toBe(0);
  });

  it("accepts a base value instead of rolling one", () => {
    const rank = engine();
    const result = rank.award(createMemberState(), "message", { now: T0, baseXp: 42 });
    expect(result.baseXp).toBe(42);
    expect(result.awardedXp).toBe(42);
  });

  it("refuses a negative base override", () => {
    const rank = engine();
    expect(() =>
      rank.award(createMemberState(), "message", { now: T0, baseXp: -1 }),
    ).toThrow(ValidationError);
  });

  it("refuses a non-finite timestamp", () => {
    const rank = engine();
    expect(() =>
      rank.award(createMemberState(), "message", { now: Number.NaN }),
    ).toThrow(ValidationError);
  });

  it("stays inside the random span", () => {
    const rank = engine();
    const source = new FixedRandomSource([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    let state = createMemberState();
    for (let i = 0; i < 11; i += 1) {
      const result = rank.award(state, "message", {
        now: T0 + i * 2 * MINUTE,
        random: source,
      });
      expect(result.awardedXp).toBeGreaterThanOrEqual(15);
      expect(result.awardedXp).toBeLessThanOrEqual(25);
      state = result.state;
    }
  });
});

describe("multipliers", () => {
  it("applies a factor to the base value", () => {
    const rank = engine();
    const result = rank.award(createMemberState(), "message", {
      now: T0,
      random: fixed(20),
      multipliers: [{ source: "double-xp-weekend", permille: 2000 }],
    });
    expect(result.awardedXp).toBe(40);
    expect(result.multiplierPermille).toBe(2000);
  });

  it("chains factors in the order they were given", () => {
    expect(
      applyMultipliers(10, [
        { source: "a", permille: 1500 },
        { source: "b", permille: 1500 },
      ]),
    ).toBe(22); // floor(10*1.5)=15, floor(15*1.5)=22
    expect(combinedPermille([
      { source: "a", permille: 1500 },
      { source: "b", permille: 1500 },
    ])).toBe(2250);
  });

  it("floors at every step, so order can matter", () => {
    const a = applyMultipliers(7, [
      { source: "a", permille: 1500 },
      { source: "b", permille: 1100 },
    ]);
    const b = applyMultipliers(7, [
      { source: "b", permille: 1100 },
      { source: "a", permille: 1500 },
    ]);
    expect(a).toBe(11); // floor(10.5)=10 -> floor(11)=11
    expect(b).toBe(10); // floor(7.7)=7 -> floor(10.5)=10
  });

  it("supports a reducing factor", () => {
    const rank = engine();
    const result = rank.award(createMemberState(), "message", {
      now: T0,
      random: fixed(20),
      multipliers: [{ source: "muted-channel", permille: 500 }],
    });
    expect(result.awardedXp).toBe(10);
  });

  it("reports NO_XP when a factor eliminates the award", () => {
    const rank = engine();
    const result = rank.award(createMemberState(), "message", {
      now: T0,
      random: fixed(20),
      multipliers: [{ source: "no-xp-channel", permille: 0 }],
    });
    expect(result.outcome).toBe(AwardOutcome.NoXp);
    expect(result.newTotalXp).toBe(0);
    expect(result.state.lastEventAt["message"]).toBeUndefined();
  });

  it("refuses a negative or fractional factor", () => {
    expect(() => applyMultipliers(10, [{ source: "x", permille: -1 }])).toThrow(
      ValidationError,
    );
    expect(() => applyMultipliers(10, [{ source: "x", permille: 1.5 }])).toThrow(
      ValidationError,
    );
  });
});

describe("period caps", () => {
  it("trims the last award of the period to what is left", () => {
    const rank = engine({
      rules: [
        createEventRule({
          eventType: "message",
          minXp: 30,
          maxXp: 30,
          cooldownSeconds: 0,
          periodCapXp: 100,
        }),
      ],
    });
    let state = createMemberState();
    for (let i = 0; i < 3; i += 1) {
      state = rank.award(state, "message", { now: T0 + i * 1000 }).state;
    }
    expect(state.totalXp).toBe(90);

    const trimmed = rank.award(state, "message", { now: T0 + 4000 });
    expect(trimmed.outcome).toBe(AwardOutcome.Awarded);
    expect(trimmed.awardedXp).toBe(10);
    expect(trimmed.newTotalXp).toBe(100);

    const blocked = rank.award(trimmed.state, "message", { now: T0 + 5000 });
    expect(blocked.outcome).toBe(AwardOutcome.PeriodCap);
    expect(blocked.periodRemainingXp).toBe(0);
  });

  it("starts a fresh period once the old one is over", () => {
    const rank = engine({
      rules: [
        createEventRule({
          eventType: "message",
          minXp: 100,
          maxXp: 100,
          cooldownSeconds: 0,
          periodCapXp: 100,
          periodSeconds: 3600,
        }),
      ],
    });
    const first = rank.award(createMemberState(), "message", { now: T0 });
    const blocked = rank.award(first.state, "message", { now: T0 + 30 * MINUTE });
    expect(blocked.outcome).toBe(AwardOutcome.PeriodCap);

    const nextPeriod = rank.award(blocked.state, "message", { now: T0 + HOUR });
    expect(nextPeriod.outcome).toBe(AwardOutcome.Awarded);
    expect(nextPeriod.awardedXp).toBe(100);
  });

  it("applies the global cap across every event type", () => {
    const rank = engine({
      rules: [
        createEventRule({ eventType: "message", minXp: 40, maxXp: 40, cooldownSeconds: 0 }),
        createEventRule({ eventType: "reaction", minXp: 40, maxXp: 40, cooldownSeconds: 0 }),
      ],
      globalCap: { xp: 100, periodSeconds: 86400 },
    });
    let state = createMemberState();
    state = rank.award(state, "message", { now: T0 }).state;
    state = rank.award(state, "reaction", { now: T0 + 1000 }).state;
    expect(state.totalXp).toBe(80);

    const trimmed = rank.award(state, "message", { now: T0 + 2000 });
    expect(trimmed.awardedXp).toBe(20);

    const blocked = rank.award(trimmed.state, "reaction", { now: T0 + 3000 });
    expect(blocked.outcome).toBe(AwardOutcome.PeriodCap);
  });

  it("uses the tighter of the rule cap and the global cap", () => {
    const rank = engine({
      rules: [
        createEventRule({
          eventType: "message",
          minXp: 10,
          maxXp: 10,
          cooldownSeconds: 0,
          periodCapXp: 500,
        }),
      ],
      globalCap: { xp: 30, periodSeconds: 86400 },
    });
    expect(rank.periodRemainingXp(createMemberState(), "message", T0)).toBe(30);
  });

  it("reports no limit when nothing caps the event", () => {
    const rank = engine({
      rules: [createEventRule({ eventType: "message", minXp: 10 })],
    });
    expect(rank.periodRemainingXp(createMemberState(), "message", T0)).toBeNull();
  });
});

describe("ceiling", () => {
  it("stops at the configured maximum", () => {
    const rank = engine({
      curve: new LinearCurve({ base: 100, maxLevel: 10 }),
      rules: [createEventRule({ eventType: "message", minXp: 50, maxXp: 50 })],
      maxTotalXp: 100,
    });
    const result = rank.award(createMemberState(80), "message", { now: T0 });
    expect(result.awardedXp).toBe(20);
    expect(result.newTotalXp).toBe(100);

    const atCeiling = rank.award(result.state, "message", { now: T0 + DAY });
    expect(atCeiling.outcome).toBe(AwardOutcome.MaxXpReached);
  });

  it("clamps the configured ceiling to the shared safe range", () => {
    const rank = engine({ maxTotalXp: Number.MAX_SAFE_INTEGER + 100 });
    expect(rank.config.maxTotalXp).toBe(MAX_TOTAL_XP);
  });
});

describe("penalize", () => {
  it("removes XP and reports the level loss", () => {
    const rank = engine();
    const result = rank.penalize(createMemberState(350), 100, { now: T0 });
    expect(result.outcome).toBe(AwardOutcome.Penalised);
    expect(result.awardedXp).toBe(-100);
    expect(result.newTotalXp).toBe(250);
    expect(result.previousLevel).toBe(2);
    expect(result.newLevel).toBe(1);
    expect(result.leveledDown).toBe(true);
  });

  it("stops at zero by default", () => {
    const rank = engine();
    const result = rank.penalize(createMemberState(30), 100, { now: T0 });
    expect(result.newTotalXp).toBe(0);
    expect(result.awardedXp).toBe(-30);
  });

  it("goes below zero when the caller allows it", () => {
    const rank = engine({ allowNegative: true });
    const result = rank.penalize(createMemberState(30), 100, { now: T0 });
    expect(result.newTotalXp).toBe(-70);
  });

  it("can consume the cooldown so the XP cannot be earned straight back", () => {
    const rank = engine();
    const result = rank.penalize(createMemberState(500), 100, {
      now: T0,
      resetCooldownFor: ["message"],
    });
    expect(result.state.lastEventAt["message"]).toBe(T0);
    const blocked = rank.award(result.state, "message", { now: T0 + 1000 });
    expect(blocked.outcome).toBe(AwardOutcome.Cooldown);
  });

  it("reports NO_XP when there is nothing to take", () => {
    const rank = engine();
    const result = rank.penalize(createMemberState(0), 100, { now: T0 });
    expect(result.outcome).toBe(AwardOutcome.NoXp);
  });

  it("refuses a negative penalty", () => {
    const rank = engine();
    expect(() => rank.penalize(createMemberState(100), -5, { now: T0 })).toThrow(
      ValidationError,
    );
  });
});

describe("decay", () => {
  const decayEngine = () =>
    engine({
      decay: {
        xpPerPeriod: 10,
        periodSeconds: 86400,
        floorXp: 0,
        graceSeconds: 7 * 86400,
      },
    });

  it("does nothing inside the grace period", () => {
    const rank = decayEngine();
    const state = createMemberState(1000);
    state.lastEventAt["message"] = T0;
    const result = rank.applyDecay(state, { now: T0 + 3 * DAY });
    expect(result.outcome).toBe(AwardOutcome.NoDecayDue);
    expect(result.newTotalXp).toBe(1000);
  });

  it("charges one period at a time after the grace period", () => {
    const rank = decayEngine();
    const state = createMemberState(1000);
    state.lastEventAt["message"] = T0;
    const result = rank.applyDecay(state, { now: T0 + 10 * DAY });
    expect(result.outcome).toBe(AwardOutcome.Decayed);
    expect(result.awardedXp).toBe(-30); // 10 days - 7 grace = 3 periods
    expect(result.newTotalXp).toBe(970);
  });

  it("produces the same result whether it runs daily or once", () => {
    const rank = decayEngine();
    const base = createMemberState(1000);
    base.lastEventAt["message"] = T0;

    const atOnce = rank.applyDecay(base, { now: T0 + 12 * DAY }).newTotalXp;

    let stepwise = base;
    for (let day = 8; day <= 12; day += 1) {
      stepwise = rank.applyDecay(stepwise, { now: T0 + day * DAY }).state;
    }
    expect(stepwise.totalXp).toBe(atOnce);
  });

  it("never decays below the floor", () => {
    const rank = engine({
      decay: { xpPerPeriod: 100, periodSeconds: 86400, floorXp: 500, graceSeconds: 0 },
    });
    const state = createMemberState(550);
    state.lastDecayAt = T0;
    const result = rank.applyDecay(state, { now: T0 + 30 * DAY });
    expect(result.newTotalXp).toBe(500);
  });

  it("reports the level loss caused by decay", () => {
    const rank = engine({
      decay: { xpPerPeriod: 100, periodSeconds: 86400, floorXp: 0, graceSeconds: 0 },
    });
    const state = createMemberState(350);
    state.lastDecayAt = T0;
    const result = rank.applyDecay(state, { now: T0 + 2 * DAY });
    expect(result.previousLevel).toBe(2);
    expect(result.newLevel).toBe(1);
    expect(result.leveledDown).toBe(true);
  });

  it("is a no-op when no decay is configured", () => {
    const rank = engine();
    const result = rank.applyDecay(createMemberState(1000), { now: T0 + 999 * DAY });
    expect(result.outcome).toBe(AwardOutcome.NoDecayDue);
    expect(result.newTotalXp).toBe(1000);
  });

  it("anchors on now for a member who never earned anything", () => {
    const rank = decayEngine();
    const result = rank.applyDecay(createMemberState(1000), { now: T0 });
    expect(result.outcome).toBe(AwardOutcome.NoDecayDue);
    expect(result.state.lastDecayAt).toBe(T0);
  });
});

describe("queries", () => {
  it("answers whether an award is possible right now", () => {
    const rank = engine();
    const state = createMemberState();
    expect(rank.canAward(state, "message", T0)).toBe(true);
    expect(rank.canAward(state, "unknown", T0)).toBe(false);

    const awarded = rank.award(state, "message", { now: T0, random: fixed(20) });
    expect(rank.canAward(awarded.state, "message", T0 + 1000)).toBe(false);
    expect(rank.canAward(awarded.state, "message", T0 + 61_000)).toBe(true);
  });

  it("exposes the rule for an event type", () => {
    const rank = engine();
    expect(rank.ruleFor("message")?.minXp).toBe(15);
    expect(rank.ruleFor("nope")).toBeNull();
  });

  it("reports progress without a state", () => {
    const rank = engine();
    expect(rank.levelFor(300)).toBe(2);
    expect(rank.progress(300).level).toBe(2);
    expect(rank.curve).toBeInstanceOf(QuadraticCurve);
  });

  it("estimates the time to a target level", () => {
    const rank = engine();
    // level 3 sits at 600; 100 XP still missing at 100 XP/h = one hour
    expect(rank.estimateTimeToLevel(500, 3, 100)).toBe(HOUR);
    expect(rank.estimateTimeToLevel(700, 3, 100)).toBe(0);
    expect(() => rank.estimateTimeToLevel(0, 3, 0)).toThrow(ValidationError);
  });

  it("reports no cooldown for a rule that has none", () => {
    const rank = engine({
      rules: [createEventRule({ eventType: "message", minXp: 10, cooldownSeconds: 0 })],
    });
    expect(rank.cooldownRemainingMs(createMemberState(), "message", T0)).toBe(0);
  });
});

describe("configuration", () => {
  it("ships a usable default configuration", () => {
    const rank = new RankEngine();
    expect(rank.curve).toBeInstanceOf(QuadraticCurve);
    expect(rank.award(createMemberState(), "message", { now: T0 }).outcome).toBe(
      AwardOutcome.UnknownEvent,
    );
  });

  it("accepts the recommended rule set", () => {
    const rank = new RankEngine({ rules: defaultRules() });
    expect(rank.ruleFor("message")?.cooldownSeconds).toBe(60);
    expect(rank.ruleFor("voice_minute")?.periodCapXp).toBe(1500);
    expect(rank.ruleFor("post")?.maxXp).toBe(40);
  });

  it("accepts loose rule input and validates it", () => {
    const rank = new RankEngine({ rules: [{ eventType: "ping", minXp: 3 }] });
    const rule = rank.ruleFor("ping");
    expect(rule?.maxXp).toBe(3);
    expect(rule?.enabled).toBe(true);
    expect(rule?.periodCapXp).toBeNull();
  });

  it("rejects duplicate event types", () => {
    expect(
      () =>
        new RankEngine({
          rules: [
            { eventType: "message", minXp: 1 },
            { eventType: "message", minXp: 2 },
          ],
        }),
    ).toThrow(ConfigurationError);
  });

  it("rejects impossible rules", () => {
    expect(() => createEventRule({ eventType: "", minXp: 1 })).toThrow(ConfigurationError);
    expect(() => createEventRule({ eventType: "*", minXp: 1 })).toThrow(ConfigurationError);
    expect(() => createEventRule({ eventType: "a", minXp: -1 })).toThrow(ConfigurationError);
    expect(() => createEventRule({ eventType: "a", minXp: 10, maxXp: 5 })).toThrow(
      ConfigurationError,
    );
    expect(() => createEventRule({ eventType: "a", minXp: 1, cooldownSeconds: -1 })).toThrow(
      ConfigurationError,
    );
    expect(() => createEventRule({ eventType: "a", minXp: 1, periodCapXp: -5 })).toThrow(
      ConfigurationError,
    );
    expect(() => createEventRule({ eventType: "a", minXp: 1, periodSeconds: 0 })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects an impossible global cap or decay rule", () => {
    expect(() => new RankEngine({ globalCap: { xp: -1, periodSeconds: 10 } })).toThrow(
      ConfigurationError,
    );
    expect(() => new RankEngine({ globalCap: { xp: 10, periodSeconds: 0 } })).toThrow(
      ConfigurationError,
    );
    expect(
      () =>
        new RankEngine({
          decay: { xpPerPeriod: -1, periodSeconds: 10, floorXp: 0, graceSeconds: 0 },
        }),
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new RankEngine({
          decay: { xpPerPeriod: 1, periodSeconds: 0, floorXp: 0, graceSeconds: 0 },
        }),
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new RankEngine({
          decay: { xpPerPeriod: 1, periodSeconds: 10, floorXp: 0.5, graceSeconds: 0 },
        }),
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new RankEngine({
          decay: { xpPerPeriod: 1, periodSeconds: 10, floorXp: 0, graceSeconds: -1 },
        }),
    ).toThrow(ConfigurationError);
  });

  it("rejects a curve that is not a Curve", () => {
    expect(() => new RankEngine({ curve: { thresholds: [0, 1] } as never })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects an impossible ceiling", () => {
    expect(() => new RankEngine({ maxTotalXp: 0 })).toThrow(ConfigurationError);
  });

  it("works with a hand-written curve", () => {
    const rank = engine({ curve: new TabularCurve([0, 5, 25, 125]) });
    expect(rank.levelFor(30)).toBe(2);
  });
});
