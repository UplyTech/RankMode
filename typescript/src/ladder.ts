/**
 * The ladder: the rank a player actually sees.
 *
 * A rating is a number between 0 and 5000 with a deviation attached. Nobody
 * wants to be told they are 1847 give or take 63. They want to be told they are
 * Gold II, and they want to know how far it is to Gold I.
 *
 * This module is that translation, and it is deliberately separate from
 * `./rating.js`. The two answer different questions:
 *
 * | module   | question                                                       |
 * | -------- | -------------------------------------------------------------- |
 * | `rating` | what the matchmaker uses. Moves on every match, by the amount the maths says, and is never rounded for effect. |
 * | `ladder` | what the player sees. Moves in whole League Points, has floors that stop a bad evening from undoing a month, and makes promotion feel like an event. |
 *
 * Keeping them apart is what lets the matchmaker be honest while the display is
 * kind. A system that has only one of the two either shows the player a number
 * that jitters after every match, or matches them against opponents chosen by a
 * number that has been smoothed for their feelings.
 *
 * **Nothing here is random and nothing here reads a clock.** A ladder position
 * follows from a rating and a stored state, and the same inputs give the same
 * answer in both editions — which is what the shared vectors check.
 */
import { PERMILLE_ONE } from "./constants.js";
import { ConfigurationError, LadderError, ValidationError } from "./errors.js";

/**
 * The named bands of the ladder, lowest first.
 *
 * Nine of them, because that is what a population of any size needs: fewer and
 * the middle is a single enormous bucket where nobody can see progress, more and
 * the names stop meaning anything.
 *
 * The top three are **apex tiers**. They have no divisions — a player there is
 * ranked against everybody else at that level by League Points alone.
 */
export enum Tier {
  Iron = "IRON",
  Bronze = "BRONZE",
  Silver = "SILVER",
  Gold = "GOLD",
  Platinum = "PLATINUM",
  Diamond = "DIAMOND",
  Master = "MASTER",
  Grandmaster = "GRANDMASTER",
  Challenger = "CHALLENGER",
}

const TIER_ORDER: readonly Tier[] = [
  Tier.Iron,
  Tier.Bronze,
  Tier.Silver,
  Tier.Gold,
  Tier.Platinum,
  Tier.Diamond,
  Tier.Master,
  Tier.Grandmaster,
  Tier.Challenger,
];

const APEX_TIERS: ReadonlySet<Tier> = new Set([Tier.Master, Tier.Grandmaster, Tier.Challenger]);

/**
 * Position in the ladder, zero for the lowest tier.
 *
 * Named `order` rather than `index` to match the Python edition, where
 * `Tier.index` would shadow `str.index` on a string enum and turn
 * `Tier.GOLD.index("O")` into a `TypeError`. One concept, one name.
 */
export function tierOrder(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

/** True for the tiers that have no divisions. */
export function isApex(tier: Tier): boolean {
  return APEX_TIERS.has(tier);
}

/** Every tier, lowest first. */
export function defaultTiers(): readonly Tier[] {
  return TIER_ORDER;
}

/**
 * The sub-bands inside a tier, hardest last.
 *
 * Numbered downwards the way every ladder numbers them: a player climbs from IV
 * to I and then out of the tier. The integer values run the other way so that a
 * larger number is a better position, which is what every comparison in this
 * module wants.
 */
export enum Division {
  Four = 1,
  Three = 2,
  Two = 3,
  One = 4,
}

const DIVISION_LABELS: Record<number, string> = { 1: "IV", 2: "III", 3: "II", 4: "I" };

/** The Roman numeral a player sees. */
export function divisionLabel(division: Division): string {
  return DIVISION_LABELS[division] as string;
}

/** What a change in League Points did to the player's position. */
export enum LadderOutcome {
  /** Points moved, the bracket did not. */
  Unchanged = "UNCHANGED",
  /** Up a division inside the same tier. */
  PromotedDivision = "PROMOTED_DIVISION",
  /** Up into the next tier. */
  PromotedTier = "PROMOTED_TIER",
  /** Down a division inside the same tier. */
  DemotedDivision = "DEMOTED_DIVISION",
  /** Down into the tier below. */
  DemotedTier = "DEMOTED_TIER",
  /** The player reached 100 points and a promotion series began. */
  SeriesStarted = "SERIES_STARTED",
  /** A series match was won or lost, and the series is still running. */
  SeriesAdvanced = "SERIES_ADVANCED",
  /** The series was lost; the player stays where they are. */
  SeriesFailed = "SERIES_FAILED",
  /** Points would have fallen below zero but a floor held them. */
  FloorHeld = "FLOOR_HELD",
}

/**
 * A promotion series in progress.
 *
 * A series is a best-of-N at the boundary of a tier. It exists because a single
 * lucky match should not move somebody into a bracket they cannot hold, and
 * because arriving in a new tier feels like something when it was earned over
 * several games.
 */
export interface SeriesState {
  readonly winsNeeded: number;
  readonly lossesAllowed: number;
  readonly wins: number;
  readonly losses: number;
}

export function createSeriesState(options: {
  winsNeeded: number;
  lossesAllowed: number;
  wins?: number;
  losses?: number;
}): SeriesState {
  const series: SeriesState = {
    winsNeeded: options.winsNeeded,
    lossesAllowed: options.lossesAllowed,
    wins: options.wins ?? 0,
    losses: options.losses ?? 0,
  };
  if (series.winsNeeded <= 0) {
    throw new ConfigurationError("winsNeeded must be positive", {
      winsNeeded: series.winsNeeded,
    });
  }
  if (series.lossesAllowed < 0) {
    throw new ConfigurationError("lossesAllowed cannot be negative", {
      lossesAllowed: series.lossesAllowed,
    });
  }
  if (series.wins < 0 || series.losses < 0) {
    throw new ValidationError("A series cannot have negative results", {});
  }
  return series;
}

/** True once enough matches have been won. */
export function isSeriesWon(series: SeriesState): boolean {
  return series.wins >= series.winsNeeded;
}

/** True once too many have been lost. */
export function isSeriesLost(series: SeriesState): boolean {
  return series.losses > series.lossesAllowed;
}

export function isSeriesOver(series: SeriesState): boolean {
  return isSeriesWon(series) || isSeriesLost(series);
}

/**
 * Where a player stands, as a player would describe it.
 *
 * `division` is `null` in an apex tier, where there are no divisions and the
 * League Points are an open-ended ladder score rather than a bracket.
 */
export interface LadderPosition {
  readonly tier: Tier;
  readonly division: Division | null;
  /** League Points inside the current bracket, 0..99 below apex, unbounded above. */
  readonly leaguePoints: number;
  /** A promotion series, if one is running. */
  readonly series: SeriesState | null;
}

export function createLadderPosition(options: {
  tier: Tier;
  division?: Division | null;
  leaguePoints: number;
  series?: SeriesState | null;
}): LadderPosition {
  const position: LadderPosition = {
    tier: options.tier,
    division: options.division ?? null,
    leaguePoints: options.leaguePoints,
    series: options.series ?? null,
  };
  if (isApex(position.tier) && position.division !== null) {
    throw new LadderError("An apex tier has no divisions", { tier: position.tier });
  }
  if (!isApex(position.tier) && position.division === null) {
    throw new LadderError("A tier below apex needs a division", { tier: position.tier });
  }
  if (position.leaguePoints < 0) {
    throw new ValidationError("League points cannot be negative", {
      leaguePoints: position.leaguePoints,
    });
  }
  return position;
}

/**
 * How ratings map onto the ladder, and how points move.
 *
 * The defaults describe a ladder that behaves the way players expect one to.
 * Every one of them is a decision, and the ones that are not obvious carry
 * their reason.
 */
export interface LadderConfig {
  /** The rating at which each tier begins, lowest first. One entry per tier. */
  readonly tierThresholds: readonly number[];
  /** Points needed to leave a division. */
  readonly pointsPerDivision: number;
  /**
   * The base League Points a win is worth. The actual amount is adjusted by how
   * far the player's rating is from their displayed bracket, so that somebody
   * under-ranked climbs faster than somebody over-ranked.
   */
  readonly basePointsGain: number;
  /** The base League Points a loss costs. */
  readonly basePointsLoss: number;
  /**
   * How far the gain may be adjusted, in permille of the base. 500 means a win
   * is worth between half and one and a half times the base.
   */
  readonly adjustmentSpanPermille: number;
  /** Matches to win in a promotion series. */
  readonly seriesWinsNeeded: number;
  /** Losses allowed in a promotion series. */
  readonly seriesLossesAllowed: number;
  /**
   * Whether a series is required to leave a tier. Division promotions inside a
   * tier never use one: they happen too often for a ceremony.
   */
  readonly seriesOnTierPromotion: boolean;
  /**
   * A player who has just been promoted cannot be demoted for this many
   * matches. Without it a promotion at 0 points is undone by the next loss,
   * which reads as a bug even though it is arithmetic.
   */
  readonly demotionProtectionMatches: number;
  /** Whether a player can fall out of a tier at all. */
  readonly allowTierDemotion: boolean;
  /** The lowest tier a player can fall to once reached. `null` means no floor. */
  readonly tierFloor: Tier | null;
}

export function createLadderConfig(options: Partial<LadderConfig> = {}): LadderConfig {
  const config: LadderConfig = {
    tierThresholds: options.tierThresholds ?? [0, 800, 1100, 1400, 1700, 2000, 2300, 2600, 2900],
    pointsPerDivision: options.pointsPerDivision ?? 100,
    basePointsGain: options.basePointsGain ?? 20,
    basePointsLoss: options.basePointsLoss ?? 18,
    adjustmentSpanPermille: options.adjustmentSpanPermille ?? 500,
    seriesWinsNeeded: options.seriesWinsNeeded ?? 3,
    seriesLossesAllowed: options.seriesLossesAllowed ?? 2,
    seriesOnTierPromotion: options.seriesOnTierPromotion ?? true,
    demotionProtectionMatches: options.demotionProtectionMatches ?? 3,
    allowTierDemotion: options.allowTierDemotion ?? true,
    tierFloor: options.tierFloor ?? null,
  };

  if (config.tierThresholds.length !== TIER_ORDER.length) {
    throw new ConfigurationError("tierThresholds needs one entry per tier", {
      expected: TIER_ORDER.length,
      given: config.tierThresholds.length,
    });
  }
  for (let index = 1; index < config.tierThresholds.length; index += 1) {
    if ((config.tierThresholds[index] as number) <= (config.tierThresholds[index - 1] as number)) {
      throw new ConfigurationError("tierThresholds must ascend strictly", {
        index,
        previous: config.tierThresholds[index - 1] as number,
        current: config.tierThresholds[index] as number,
      });
    }
  }
  if (config.pointsPerDivision <= 0) {
    throw new ConfigurationError("pointsPerDivision must be positive", {
      pointsPerDivision: config.pointsPerDivision,
    });
  }
  for (const name of ["basePointsGain", "basePointsLoss"] as const) {
    if (config[name] < 0) {
      throw new ConfigurationError(`${name} cannot be negative`, { [name]: config[name] });
    }
  }
  if (config.adjustmentSpanPermille < 0 || config.adjustmentSpanPermille > PERMILLE_ONE) {
    throw new ConfigurationError("adjustmentSpanPermille must be between 0 and 1000", {
      adjustmentSpanPermille: config.adjustmentSpanPermille,
    });
  }
  if (config.demotionProtectionMatches < 0) {
    throw new ConfigurationError("demotionProtectionMatches cannot be negative", {
      demotionProtectionMatches: config.demotionProtectionMatches,
    });
  }
  return config;
}

/** True when promotion series are switched on at all. */
export function usesSeries(config: LadderConfig): boolean {
  return config.seriesOnTierPromotion && config.seriesWinsNeeded > 0;
}

/**
 * The bracket a rating corresponds to, ignoring any stored progress.
 *
 * This is the seeding function: it answers "where does this rating belong?" for
 * a player who has no ladder history — after placements, after a season reset,
 * or when a caller wants to show what a rating is worth without carrying the
 * ladder state around.
 *
 * A player's *actual* position comes from their stored state, because a ladder
 * deliberately lags a rating. Use `applyLeaguePoints` for that.
 */
export function positionForRating(rating: number, config?: LadderConfig): LadderPosition {
  const settings = config ?? createLadderConfig();
  if (!Number.isSafeInteger(rating)) {
    throw new ValidationError("rating must be an integer", { rating });
  }

  let index = 0;
  for (let candidate = 0; candidate < settings.tierThresholds.length; candidate += 1) {
    if (rating >= (settings.tierThresholds[candidate] as number)) {
      index = candidate;
    } else {
      break;
    }
  }
  const tier = TIER_ORDER[index] as Tier;

  if (isApex(tier)) {
    // Above apex the League Points are the ladder: one point per rating point
    // above the threshold, so the ordering is the rating's ordering.
    return createLadderPosition({
      tier,
      division: null,
      leaguePoints: Math.max(0, rating - (settings.tierThresholds[index] as number)),
    });
  }

  const span =
    (settings.tierThresholds[index + 1] as number) - (settings.tierThresholds[index] as number);
  // Clamped at zero, and that clamp is load-bearing. A rating below the lowest
  // threshold is a perfectly ordinary input — the floor is configurable, and a
  // caller is free to hand this function a number from anywhere — but the
  // difference is then negative, the floor division sends the division index to
  // -1, and there is no division zero. This edition would have cast the -1 to a
  // `Division` and returned a position no other function accepts; the Python one
  // raised. The right answer for somebody below the bottom of the ladder is the
  // bottom of the ladder.
  const intoTier = Math.max(0, rating - (settings.tierThresholds[index] as number));
  const divisionSize = Math.floor(span / 4);

  let divisionIndex: number;
  let points: number;
  if (divisionSize <= 0) {
    divisionIndex = 0;
    points = 0;
  } else {
    divisionIndex = Math.max(0, Math.min(3, Math.floor(intoTier / divisionSize)));
    const intoDivision = intoTier - divisionIndex * divisionSize;
    points = Math.floor((intoDivision * settings.pointsPerDivision) / divisionSize);
    points = Math.max(0, Math.min(settings.pointsPerDivision - 1, points));
  }

  return createLadderPosition({
    tier,
    division: (divisionIndex + 1) as Division,
    leaguePoints: points,
  });
}

/**
 * The rating a bracket corresponds to.
 *
 * The inverse of `positionForRating`, to the precision a bracket can carry.
 * Used when a season reset has to turn a displayed rank back into a rating, and
 * by the tests, which check that the round trip lands in the same bracket it
 * started in.
 */
export function ratingForPosition(position: LadderPosition, config?: LadderConfig): number {
  const settings = config ?? createLadderConfig();
  const index = tierOrder(position.tier);
  const base = settings.tierThresholds[index] as number;

  if (isApex(position.tier)) {
    return base + position.leaguePoints;
  }

  const span = (settings.tierThresholds[index + 1] as number) - base;
  const divisionSize = Math.floor(span / 4);
  const divisionIndex = (position.division ?? Division.Four) - 1;
  let into = divisionIndex * divisionSize;
  into += Math.floor((position.leaguePoints * divisionSize) / settings.pointsPerDivision);
  return base + into;
}

/**
 * `-1`, `0` or `1`: which of two positions is higher.
 *
 * Tier first, then division, then points. Written out rather than left to a
 * tuple comparison because the two editions have to agree about it, and
 * JavaScript has no tuple comparison to agree with.
 */
export function comparePositions(left: LadderPosition, right: LadderPosition): number {
  const leftTier = tierOrder(left.tier);
  const rightTier = tierOrder(right.tier);
  if (leftTier !== rightTier) {
    return leftTier < rightTier ? -1 : 1;
  }

  const leftDivision = left.division ?? 0;
  const rightDivision = right.division ?? 0;
  if (leftDivision !== rightDivision) {
    return leftDivision < rightDivision ? -1 : 1;
  }

  if (left.leaguePoints !== right.leaguePoints) {
    return left.leaguePoints < right.leaguePoints ? -1 : 1;
  }
  return 0;
}

/** The position as a player would read it: `"Gold II, 47 LP"`. */
export function formatPosition(position: LadderPosition): string {
  const name = position.tier.charAt(0) + position.tier.slice(1).toLowerCase();
  if (position.division === null) {
    return `${name}, ${position.leaguePoints} LP`;
  }
  return `${name} ${divisionLabel(position.division)}, ${position.leaguePoints} LP`;
}

/** What one match did to a ladder position. */
export interface LadderChange {
  readonly outcome: LadderOutcome;
  readonly previous: LadderPosition;
  readonly current: LadderPosition;
  /** League Points gained or lost. Signed. */
  readonly pointsDelta: number;
  /** True when the tier changed in either direction. */
  readonly tierChanged: boolean;
  /** True when this match started, advanced or ended a promotion series. */
  readonly seriesActive: boolean;
}

/**
 * Move a player up or down the ladder by one match.
 *
 * The amount is the base gain or loss, adjusted by how far the player's rating
 * has drifted from the bracket they are displayed in. A player whose rating says
 * Platinum while their bracket says Gold gains more per win and loses less per
 * loss, and so climbs to where they belong within a few matches instead of a few
 * dozen. That adjustment is the entire reason the rating and the ladder are
 * separate numbers.
 */
export function applyLeaguePoints(
  position: LadderPosition,
  won: boolean,
  rating: number,
  config?: LadderConfig,
  matchesSincePromotion = 999,
): LadderChange {
  const settings = config ?? createLadderConfig();

  const delta = pointsDelta(position, won, rating, settings);

  // A promotion series in progress takes precedence: points do not move during
  // one, only the series record does.
  if (position.series !== null && !isSeriesOver(position.series)) {
    return advanceSeries(position, won, settings);
  }

  const points = position.leaguePoints + delta;

  if (won) {
    return handleGain(position, points, delta, settings);
  }
  return handleLoss(position, points, delta, settings, matchesSincePromotion);
}

/** The signed League Point change for one match. */
function pointsDelta(
  position: LadderPosition,
  won: boolean,
  rating: number,
  settings: LadderConfig,
): number {
  const base = won ? settings.basePointsGain : -settings.basePointsLoss;
  if (settings.adjustmentSpanPermille === 0) {
    return base;
  }

  // How far the rating is from the middle of the displayed bracket, measured in
  // divisions. Positive means under-ranked: the rating is above the bracket, so
  // the player should climb faster.
  const expected = ratingForPosition(position, settings);
  const index = tierOrder(position.tier);
  const span = isApex(position.tier)
    ? Math.max(1, settings.pointsPerDivision)
    : Math.max(
        1,
        Math.floor(
          ((settings.tierThresholds[index + 1] as number) -
            (settings.tierThresholds[index] as number)) /
            4,
        ),
      );
  // Floor rather than truncate: the numerator is negative for an over-ranked
  // player, and truncating would make the two editions disagree by one permille.
  let drift = Math.floor(((rating - expected) * PERMILLE_ONE) / span);
  const limit = settings.adjustmentSpanPermille;
  drift = Math.max(-limit, Math.min(limit, drift));

  // Under-ranked players lose less; over-ranked lose more.
  const adjusted = won ? base * (PERMILLE_ONE + drift) : base * (PERMILLE_ONE - drift);

  // Round away from zero so a match is always worth at least one point.
  if (adjusted >= 0) {
    const result = Math.floor((adjusted + PERMILLE_ONE / 2) / PERMILLE_ONE);
    return won ? Math.max(1, result) : result;
  }
  const result = -Math.floor((-adjusted + PERMILLE_ONE / 2) / PERMILLE_ONE);
  return won ? result : Math.min(-1, result);
}

/** A win that may cross a division or tier boundary. */
function handleGain(
  position: LadderPosition,
  points: number,
  delta: number,
  settings: LadderConfig,
): LadderChange {
  if (isApex(position.tier)) {
    // No brackets above apex: the points simply accumulate.
    return {
      outcome: LadderOutcome.Unchanged,
      previous: position,
      current: { ...position, leaguePoints: points },
      pointsDelta: delta,
      tierChanged: false,
      seriesActive: false,
    };
  }

  if (points < settings.pointsPerDivision) {
    return {
      outcome: LadderOutcome.Unchanged,
      previous: position,
      current: { ...position, leaguePoints: points },
      pointsDelta: delta,
      tierChanged: false,
      seriesActive: false,
    };
  }

  const division = position.division ?? Division.Four;
  const leavingTier = division === Division.One;

  if (leavingTier && usesSeries(settings)) {
    const series = createSeriesState({
      winsNeeded: settings.seriesWinsNeeded,
      lossesAllowed: settings.seriesLossesAllowed,
    });
    return {
      outcome: LadderOutcome.SeriesStarted,
      previous: position,
      current: { ...position, leaguePoints: settings.pointsPerDivision, series },
      pointsDelta: delta,
      tierChanged: false,
      seriesActive: true,
    };
  }

  if (leavingTier) {
    return promoteTier(position, points - settings.pointsPerDivision, delta, settings);
  }

  return {
    outcome: LadderOutcome.PromotedDivision,
    previous: position,
    current: createLadderPosition({
      tier: position.tier,
      division: (division + 1) as Division,
      leaguePoints: points - settings.pointsPerDivision,
    }),
    pointsDelta: delta,
    tierChanged: false,
    seriesActive: false,
  };
}

/** Move into the next tier, carrying the surplus points. */
function promoteTier(
  position: LadderPosition,
  carry: number,
  delta: number,
  settings: LadderConfig,
): LadderChange {
  const nextIndex = tierOrder(position.tier) + 1;
  if (nextIndex >= TIER_ORDER.length) {
    // Already at the top of the ladder; the points stay where they are.
    return {
      outcome: LadderOutcome.Unchanged,
      previous: position,
      current: { ...position, leaguePoints: settings.pointsPerDivision - 1 },
      pointsDelta: delta,
      tierChanged: false,
      seriesActive: false,
    };
  }

  const nextTier = TIER_ORDER[nextIndex] as Tier;
  return {
    outcome: LadderOutcome.PromotedTier,
    previous: position,
    current: createLadderPosition({
      tier: nextTier,
      division: isApex(nextTier) ? null : Division.Four,
      leaguePoints: carry,
    }),
    pointsDelta: delta,
    tierChanged: true,
    seriesActive: false,
  };
}

/** A loss that may cross a division or tier boundary downwards. */
function handleLoss(
  position: LadderPosition,
  points: number,
  delta: number,
  settings: LadderConfig,
  matchesSincePromotion: number,
): LadderChange {
  if (points >= 0) {
    return {
      outcome: LadderOutcome.Unchanged,
      previous: position,
      current: { ...position, leaguePoints: points },
      pointsDelta: delta,
      tierChanged: false,
      seriesActive: false,
    };
  }

  if (isApex(position.tier)) {
    // Falling below the apex threshold drops out of the apex tier.
    if (tierOrder(position.tier) === 0 || !settings.allowTierDemotion) {
      return floorHeld(position, delta);
    }
    return demoteTier(position, delta, settings);
  }

  const protectedFromDemotion = matchesSincePromotion < settings.demotionProtectionMatches;
  const division = position.division ?? Division.Four;

  if (division !== Division.Four) {
    if (protectedFromDemotion) {
      return floorHeld(position, delta);
    }
    return {
      outcome: LadderOutcome.DemotedDivision,
      previous: position,
      current: createLadderPosition({
        tier: position.tier,
        division: (division - 1) as Division,
        leaguePoints: settings.pointsPerDivision + points,
      }),
      pointsDelta: delta,
      tierChanged: false,
      seriesActive: false,
    };
  }

  // At the bottom division of a tier: this is a tier demotion, if allowed.
  if (!settings.allowTierDemotion || protectedFromDemotion) {
    return floorHeld(position, delta);
  }
  if (settings.tierFloor !== null && tierOrder(position.tier) <= tierOrder(settings.tierFloor)) {
    return floorHeld(position, delta);
  }
  if (tierOrder(position.tier) === 0) {
    return floorHeld(position, delta);
  }

  return demoteTier(position, delta, settings);
}

/** Drop into the tier below, landing near its top. */
function demoteTier(
  position: LadderPosition,
  delta: number,
  settings: LadderConfig,
): LadderChange {
  const lower = TIER_ORDER[tierOrder(position.tier) - 1] as Tier;
  return {
    outcome: LadderOutcome.DemotedTier,
    previous: position,
    current: createLadderPosition({
      tier: lower,
      division: isApex(lower) ? null : Division.One,
      // Landing at 75 rather than 99 so that one win does not immediately start
      // another promotion series: a player bouncing on a tier boundary every
      // other match is the worst experience a ladder has.
      leaguePoints: Math.floor((settings.pointsPerDivision * 3) / 4),
    }),
    pointsDelta: delta,
    tierChanged: true,
    seriesActive: false,
  };
}

/** A loss that would have demoted, held at zero points. */
function floorHeld(position: LadderPosition, delta: number): LadderChange {
  return {
    outcome: LadderOutcome.FloorHeld,
    previous: position,
    current: { ...position, leaguePoints: 0 },
    pointsDelta: delta,
    tierChanged: false,
    seriesActive: false,
  };
}

/** One match inside a promotion series. */
function advanceSeries(
  position: LadderPosition,
  won: boolean,
  settings: LadderConfig,
): LadderChange {
  const series = position.series;
  /* c8 ignore next 3 -- guarded by the caller */
  if (series === null) {
    throw new LadderError("No series is running", { tier: position.tier });
  }
  const updated: SeriesState = {
    ...series,
    wins: series.wins + (won ? 1 : 0),
    losses: series.losses + (won ? 0 : 1),
  };

  if (isSeriesWon(updated)) {
    const promoted = promoteTier({ ...position, series: null }, 0, 0, settings);
    return {
      outcome: promoted.outcome,
      previous: position,
      current: promoted.current,
      pointsDelta: 0,
      tierChanged: promoted.tierChanged,
      seriesActive: false,
    };
  }

  if (isSeriesLost(updated)) {
    return {
      outcome: LadderOutcome.SeriesFailed,
      previous: position,
      current: {
        ...position,
        // Dropped to three quarters rather than zero: failing a series should
        // cost something without erasing the climb to it.
        leaguePoints: Math.floor((settings.pointsPerDivision * 3) / 4),
        series: null,
      },
      pointsDelta: 0,
      tierChanged: false,
      seriesActive: false,
    };
  }

  return {
    outcome: LadderOutcome.SeriesAdvanced,
    previous: position,
    current: { ...position, series: updated },
    pointsDelta: 0,
    tierChanged: false,
    seriesActive: true,
  };
}
