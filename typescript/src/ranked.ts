/**
 * The ranked engine: a match goes in, a new state comes out.
 *
 * Everything else in this half of the library is a piece — a rating formula, a
 * ladder bracket, a season reset. This is the one object a caller actually
 * holds, and it does for competitive play exactly what `RankEngine` does for
 * participation XP: takes the state you stored, takes what happened, and hands
 * back a new state and a description of what changed.
 *
 * The order of operations is fixed and part of the public contract, because a
 * different order produces different numbers:
 *
 * 1. the season is checked — a state from an old season is reset before
 *    anything else touches it
 * 2. the rating is updated by the configured system
 * 3. placements are counted, and a player still in them gets no visible rank
 * 4. the ladder position moves, unless placements are still running
 * 5. streaks are updated
 * 6. the peak is recorded, because rewards are based on it
 *
 * Nothing here reads a clock or a random generator. `now` is a parameter for the
 * same reason it is one everywhere else in this library: a season boundary that
 * depends on the wall clock cannot be tested.
 */
import { PERMILLE_ONE } from "./constants.js";
import { ConfigurationError, ValidationError } from "./errors.js";
import {
  type Division,
  type LadderChange,
  type LadderConfig,
  LadderOutcome,
  type LadderPosition,
  type SeriesState,
  Tier,
  applyLeaguePoints,
  comparePositions,
  createLadderConfig,
  createLadderPosition,
  createSeriesState,
  positionForRating,
} from "./ladder.js";
import {
  DEFAULT_DEVIATION,
  DEFAULT_RATING,
  DEFAULT_VOLATILITY,
  type EloConfig,
  type Glicko2Config,
  MatchOutcome,
  type Rating,
  RatingSystem,
  createEloConfig,
  createGlicko2Config,
  createRating,
  expectedScorePermille,
  updateElo,
  updateGlicko2,
} from "./rating.js";
import {
  type Season,
  type SeasonResetConfig,
  type SeasonSummary,
  createSeasonResetConfig,
  resetRating,
} from "./season.js";

/** Everything a ranked engine needs, validated once at construction. */
export interface RankedConfig {
  /** Which rating formula. Glicko-2 by default; see `./rating.js`. */
  readonly system: RatingSystem;
  readonly elo: EloConfig;
  readonly glicko2: Glicko2Config;
  readonly ladder: LadderConfig;
  readonly reset: SeasonResetConfig;
  /**
   * The current season. `null` means the ladder has no seasons, which is a valid
   * choice for a small community.
   */
  readonly season: Season | null;
  /**
   * How many matches a player plays before they are given a rank. During
   * placements the rating moves normally and the ladder does not — showing
   * somebody Bronze after one loss is how a ladder loses a player on their first
   * evening.
   */
  readonly placementMatches: number;
  /**
   * Consecutive wins before a streak bonus applies. `0` switches streaks off,
   * which is right for any ladder that takes its rating seriously: a streak
   * bonus is a deliberate distortion of the maths in exchange for the ladder
   * feeling responsive.
   */
  readonly streakThreshold: number;
  /**
   * Extra League Points per win once a streak is running, per win beyond the
   * threshold, capped by `maxStreakBonus`.
   */
  readonly streakBonusPoints: number;
  readonly maxStreakBonus: number;
}

export function createRankedConfig(options: Partial<RankedConfig> = {}): RankedConfig {
  const config: RankedConfig = {
    system: options.system ?? RatingSystem.Glicko2,
    elo: options.elo ?? createEloConfig(),
    glicko2: options.glicko2 ?? createGlicko2Config(),
    ladder: options.ladder ?? createLadderConfig(),
    reset: options.reset ?? createSeasonResetConfig(),
    season: options.season ?? null,
    placementMatches: options.placementMatches ?? 10,
    streakThreshold: options.streakThreshold ?? 3,
    streakBonusPoints: options.streakBonusPoints ?? 2,
    maxStreakBonus: options.maxStreakBonus ?? 10,
  };
  if (config.placementMatches < 0) {
    throw new ConfigurationError("placementMatches cannot be negative", {
      placementMatches: config.placementMatches,
    });
  }
  if (config.streakThreshold < 0) {
    throw new ConfigurationError("streakThreshold cannot be negative", {
      streakThreshold: config.streakThreshold,
    });
  }
  if (config.streakBonusPoints < 0 || config.maxStreakBonus < 0) {
    throw new ConfigurationError("A streak bonus cannot be negative", {
      streakBonusPoints: config.streakBonusPoints,
      maxStreakBonus: config.maxStreakBonus,
    });
  }
  return config;
}

/**
 * Everything the engine needs to know about one player.
 *
 * Mutable, like `MemberState`, and for the same reason: the caller loads it from
 * a database, hands it in, and stores the copy that comes back. The engine never
 * modifies the instance it is given.
 */
export interface RankedState {
  rating: Rating;
  /** `null` until placements are finished. */
  position: LadderPosition | null;
  /**
   * Which season this state belongs to. A state from an older season is reset on
   * the next match rather than trusted.
   */
  seasonId: string | null;
  /** Matches played this season, which is what placements count. */
  seasonMatches: number;
  wins: number;
  losses: number;
  draws: number;
  /** Consecutive wins, or negative for consecutive losses. */
  streak: number;
  /**
   * The highest rating and position reached this season. Rewards are based on
   * these, not on where the player finishes.
   */
  peakRating: number;
  peakPosition: LadderPosition | null;
  /** Matches since the last promotion, for demotion protection. */
  matchesSincePromotion: number;
  /**
   * Epoch milliseconds of the last ranked match, so a caller can apply
   * inactivity rules without keeping a second record.
   */
  lastMatchAt: number | null;
}

/** A state for a player who has never played a ranked match. */
export function createRankedState(rating?: Rating): RankedState {
  const start = rating ?? createRating();
  return {
    rating: start,
    position: null,
    seasonId: null,
    seasonMatches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    streak: 0,
    peakRating: start.rating,
    peakPosition: null,
    matchesSincePromotion: 999,
    lastMatchAt: null,
  };
}

/** Deep copy. The engine never mutates the state it is handed. */
export function cloneRankedState(state: RankedState): RankedState {
  return {
    rating: state.rating,
    position: state.position,
    seasonId: state.seasonId,
    seasonMatches: state.seasonMatches,
    wins: state.wins,
    losses: state.losses,
    draws: state.draws,
    streak: state.streak,
    peakRating: state.peakRating,
    peakPosition: state.peakPosition,
    matchesSincePromotion: state.matchesSincePromotion,
    lastMatchAt: state.lastMatchAt,
  };
}

/** What one match did. */
export interface MatchResult {
  readonly outcome: MatchOutcome;
  readonly previousRating: Rating;
  readonly newRating: Rating;
  /** Signed change in rating points. */
  readonly ratingDelta: number;
  /** What the ladder did, or `null` while placements are running. */
  readonly ladder: LadderChange | null;
  /** `true` while the player is still in placements. */
  readonly inPlacements: boolean;
  /** How many placement matches are left. */
  readonly placementsRemaining: number;
  /**
   * The chance the player had of winning, in permille. Useful for a post-match
   * screen, and for a caller who wants to detect an unbalanced queue.
   */
  readonly expectedPermille: number;
  /** The streak after this match. Positive for wins, negative for losses. */
  readonly streak: number;
  /** The new state. Persist this; the input state is untouched. */
  readonly state: RankedState;
  /** True when the season changed and the state was reset before the match. */
  readonly seasonReset: boolean;
}

/** Competitive ranking: rating, ladder, seasons and placements in one object. */
export class RankedEngine {
  readonly config: RankedConfig;

  constructor(config?: RankedConfig) {
    this.config = config ?? createRankedConfig();
  }

  // -- queries ------------------------------------------------------------

  /** The player's chance of winning, in permille. */
  expected(player: RankedState, opponent: RankedState): number {
    return expectedScorePermille(player.rating, opponent.rating, this.config.system);
  }

  /** Where the player currently stands, or `null` during placements. */
  positionOf(state: RankedState): LadderPosition | null {
    return state.position;
  }

  /**
   * Where the player's rating says they belong, placements or not.
   *
   * The number a placement screen shows as "you are on track for …". It is
   * deliberately not the same as `positionOf`, which is `null` until placements
   * finish.
   */
  previewPosition(state: RankedState): LadderPosition {
    return positionForRating(state.rating.rating, this.config.ladder);
  }

  isInPlacements(state: RankedState): boolean {
    return state.seasonMatches < this.config.placementMatches;
  }

  // -- state changes ------------------------------------------------------

  /**
   * Record one ranked match and return the new state.
   *
   * `opponent` is a rating rather than a state, because the engine needs nothing
   * else about them: their ladder position, their season and their streak are
   * their own business, and asking for them would make a two-player call need
   * two full states.
   */
  recordMatch(
    state: RankedState,
    opponent: Rating,
    outcome: MatchOutcome,
    now: number,
  ): MatchResult {
    if (!Number.isSafeInteger(now)) {
      throw new ValidationError(
        "now must be an epoch-millisecond timestamp as an integer",
        { now },
      );
    }

    const [working, wasReset] = this.applySeason(state);
    const previousRating = working.rating;
    const expected = expectedScorePermille(previousRating, opponent, this.config.system);

    const newRating = this.updateRating(previousRating, opponent, outcome);

    const next = cloneRankedState(working);
    next.rating = newRating;
    next.seasonMatches = working.seasonMatches + 1;
    next.lastMatchAt = now;
    next.streak = nextStreak(working.streak, outcome);

    if (outcome === MatchOutcome.Win) {
      next.wins += 1;
    } else if (outcome === MatchOutcome.Loss) {
      next.losses += 1;
    } else {
      next.draws += 1;
    }

    const inPlacements = next.seasonMatches < this.config.placementMatches;
    let ladderChange: LadderChange | null = null;

    if (inPlacements) {
      // No visible rank yet. The rating still moved, and that is what decides
      // where the player lands when placements finish.
      next.position = null;
    } else if (working.position === null) {
      // Placements just ended: seed the position from the rating.
      next.position = positionForRating(newRating.rating, this.config.ladder);
      next.matchesSincePromotion = 0;
    } else {
      ladderChange = this.moveLadder(working, next, outcome);
      next.position = ladderChange.current;
      if (
        ladderChange.outcome === LadderOutcome.PromotedTier ||
        ladderChange.outcome === LadderOutcome.PromotedDivision
      ) {
        next.matchesSincePromotion = 0;
      } else {
        next.matchesSincePromotion = working.matchesSincePromotion + 1;
      }
    }

    if (newRating.rating > next.peakRating) {
      next.peakRating = newRating.rating;
    }
    if (next.position !== null) {
      if (next.peakPosition === null || comparePositions(next.position, next.peakPosition) > 0) {
        next.peakPosition = next.position;
      }
    }

    return {
      outcome,
      previousRating,
      newRating,
      ratingDelta: newRating.rating - previousRating.rating,
      ladder: ladderChange,
      inPlacements,
      placementsRemaining: Math.max(0, this.config.placementMatches - next.seasonMatches),
      expectedPermille: expected,
      streak: next.streak,
      state: next,
      seasonReset: wasReset,
    };
  }

  /**
   * Record a whole rating period at once.
   *
   * Glicko-2 is defined over a period rather than a match, and applying a week's
   * results together is both more accurate and what Glickman intended. The
   * ladder still moves once per match, in the order given, because a ladder is a
   * running display and cannot be batched.
   *
   * An empty list is not an error: it is the case Glicko-2 has an answer for, a
   * player who did not play, whose deviation widens on its own.
   */
  recordPeriod(
    state: RankedState,
    results: readonly (readonly [Rating, MatchOutcome])[],
    now: number,
  ): MatchResult {
    if (results.length === 0) {
      const [working, wasReset] = this.applySeason(state);
      const next = cloneRankedState(working);
      next.rating = updateGlicko2(working.rating, [], this.config.glicko2);
      return {
        outcome: MatchOutcome.Draw,
        previousRating: working.rating,
        newRating: next.rating,
        ratingDelta: next.rating.rating - working.rating.rating,
        ladder: null,
        inPlacements: this.isInPlacements(next),
        placementsRemaining: Math.max(0, this.config.placementMatches - next.seasonMatches),
        expectedPermille: Math.floor(PERMILLE_ONE / 2),
        streak: next.streak,
        state: next,
        seasonReset: wasReset,
      };
    }

    let result: MatchResult | null = null;
    let current = state;
    for (const [opponent, outcome] of results) {
      result = this.recordMatch(current, opponent, outcome, now);
      current = result.state;
    }
    /* c8 ignore next 3 -- the loop runs at least once */
    if (result === null) {
      throw new ValidationError("No results were recorded", {});
    }
    return result;
  }

  /** The season summary a rewards screen needs. */
  summarise(state: RankedState): SeasonSummary {
    return {
      seasonId: state.seasonId ?? "",
      matchesPlayed: state.seasonMatches,
      wins: state.wins,
      losses: state.losses,
      draws: state.draws,
      peakRating: state.peakRating,
      finalRating: state.rating.rating,
      peakPosition: state.peakPosition,
      finalPosition: state.position,
    };
  }

  /**
   * Carry a player into a new season explicitly.
   *
   * `recordMatch` does this on its own when it sees a state from an old season.
   * This method exists for the caller who wants to run the reset for everybody at
   * a fixed moment rather than lazily on each player's first match — which is
   * what a ladder with a leaderboard has to do, because the leaderboard is wrong
   * until everybody has been reset.
   */
  startSeason(state: RankedState, season: Season): RankedState {
    const fresh = cloneRankedState(state);
    fresh.rating = resetRating(state.rating, this.config.reset);
    fresh.position = null;
    fresh.seasonId = season.id;
    fresh.seasonMatches = 0;
    fresh.wins = 0;
    fresh.losses = 0;
    fresh.draws = 0;
    fresh.streak = 0;
    fresh.peakRating = fresh.rating.rating;
    fresh.peakPosition = null;
    fresh.matchesSincePromotion = 999;
    return fresh;
  }

  // -- internals ----------------------------------------------------------

  /** Reset the state if it belongs to a season that is over. */
  private applySeason(state: RankedState): [RankedState, boolean] {
    const season = this.config.season;
    if (season === null) {
      return [state, false];
    }
    if (state.seasonId === season.id) {
      return [state, false];
    }
    return [this.startSeason(state, season), state.seasonId !== null];
  }

  private updateRating(rating: Rating, opponent: Rating, outcome: MatchOutcome): Rating {
    if (this.config.system === RatingSystem.Elo) {
      return updateElo(rating, opponent, outcome, this.config.elo);
    }
    return updateGlicko2(rating, [[opponent, outcome]], this.config.glicko2);
  }

  /** Move the ladder, including any streak bonus. */
  private moveLadder(
    previous: RankedState,
    next: RankedState,
    outcome: MatchOutcome,
  ): LadderChange {
    const position = previous.position;
    /* c8 ignore next 3 -- guarded by the caller */
    if (position === null) {
      throw new ValidationError("No ladder position to move", {});
    }

    if (outcome === MatchOutcome.Draw) {
      // A draw moves the rating and leaves the ladder alone. Splitting a League
      // Point in half would be worse than not moving.
      return {
        outcome: LadderOutcome.Unchanged,
        previous: position,
        current: position,
        pointsDelta: 0,
        tierChanged: false,
        seriesActive: position.series !== null,
      };
    }

    const won = outcome === MatchOutcome.Win;
    const change = applyLeaguePoints(
      position,
      won,
      next.rating.rating,
      this.config.ladder,
      previous.matchesSincePromotion,
    );

    const bonus = won ? this.streakBonus(next.streak) : 0;
    if (bonus === 0 || change.current.series !== null) {
      return change;
    }

    // The bonus is applied as a second, smaller move so that it can carry a
    // player across a boundary the base gain did not reach.
    const boosted = applyLeaguePoints(
      change.current,
      true,
      next.rating.rating,
      { ...this.config.ladder, basePointsGain: bonus, adjustmentSpanPermille: 0 },
      0,
    );
    return {
      outcome:
        boosted.outcome !== LadderOutcome.Unchanged ? boosted.outcome : change.outcome,
      previous: position,
      current: boosted.current,
      pointsDelta: change.pointsDelta + boosted.pointsDelta,
      tierChanged: change.tierChanged || boosted.tierChanged,
      seriesActive: boosted.seriesActive,
    };
  }

  private streakBonus(streak: number): number {
    const settings = this.config;
    if (settings.streakThreshold === 0 || streak < settings.streakThreshold) {
      return 0;
    }
    const beyond = streak - settings.streakThreshold + 1;
    return Math.min(settings.maxStreakBonus, beyond * settings.streakBonusPoints);
  }
}

/**
 * The streak after one match.
 *
 * A draw breaks a streak rather than continuing it. A run of wins interrupted by
 * a draw is not a run of wins, and treating it as one makes the bonus feel
 * arbitrary.
 */
function nextStreak(streak: number, outcome: MatchOutcome): number {
  if (outcome === MatchOutcome.Win) {
    return streak > 0 ? streak + 1 : 1;
  }
  if (outcome === MatchOutcome.Loss) {
    return streak < 0 ? streak - 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** The serialised shape of a ladder position. */
export interface SerializedPosition {
  readonly tier: string;
  readonly division: number | null;
  readonly leaguePoints: number;
  readonly series: {
    readonly winsNeeded: number;
    readonly lossesAllowed: number;
    readonly wins: number;
    readonly losses: number;
  } | null;
}

/** The serialised shape of a ranked state. */
export interface SerializedRankedState {
  readonly rating: {
    readonly rating: number;
    readonly deviation: number;
    readonly volatility: number;
    readonly matchesPlayed: number;
  };
  readonly position: SerializedPosition | null;
  readonly seasonId: string | null;
  readonly seasonMatches: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly streak: number;
  readonly peakRating: number;
  readonly peakPosition: SerializedPosition | null;
  readonly matchesSincePromotion: number;
  readonly lastMatchAt: number | null;
}

/**
 * Plain-object form, ready for `JSON.stringify`.
 *
 * The JSON field names are camelCase, matching every other serialised shape in
 * this library, so a bot ported between the editions keeps its data.
 */
export function serializeRankedState(state: RankedState): SerializedRankedState {
  return {
    rating: {
      rating: state.rating.rating,
      deviation: state.rating.deviation,
      volatility: state.rating.volatility,
      matchesPlayed: state.rating.matchesPlayed,
    },
    position: serializePosition(state.position),
    seasonId: state.seasonId,
    seasonMatches: state.seasonMatches,
    wins: state.wins,
    losses: state.losses,
    draws: state.draws,
    streak: state.streak,
    peakRating: state.peakRating,
    peakPosition: serializePosition(state.peakPosition),
    matchesSincePromotion: state.matchesSincePromotion,
    lastMatchAt: state.lastMatchAt,
  };
}

function serializePosition(position: LadderPosition | null): SerializedPosition | null {
  if (position === null) {
    return null;
  }
  return {
    tier: position.tier,
    division: position.division ?? null,
    leaguePoints: position.leaguePoints,
    series:
      position.series === null
        ? null
        : {
            winsNeeded: position.series.winsNeeded,
            lossesAllowed: position.series.lossesAllowed,
            wins: position.series.wins,
            losses: position.series.losses,
          },
  };
}

/**
 * Rebuild a state from stored data.
 *
 * Missing fields take their empty defaults, so a row written by an older version
 * of the calling bot still loads.
 */
export function deserializeRankedState(raw: unknown): RankedState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("A ranked state must be an object", {
      received: raw === null ? "null" : typeof raw,
    });
  }
  const record = raw as Record<string, unknown>;

  const ratingRaw = (record.rating ?? {}) as Record<string, unknown>;
  const rating = createRating({
    rating: intField(ratingRaw, "rating", DEFAULT_RATING),
    deviation: intField(ratingRaw, "deviation", DEFAULT_DEVIATION),
    volatility: intField(ratingRaw, "volatility", DEFAULT_VOLATILITY),
    matchesPlayed: intField(ratingRaw, "matchesPlayed", 0),
  });

  const seasonId = record.seasonId;
  const lastMatchAt = record.lastMatchAt;

  return {
    rating,
    position: deserializePosition(record.position),
    seasonId: seasonId === undefined || seasonId === null ? null : String(seasonId),
    seasonMatches: intField(record, "seasonMatches", 0),
    wins: intField(record, "wins", 0),
    losses: intField(record, "losses", 0),
    draws: intField(record, "draws", 0),
    streak: intField(record, "streak", 0),
    peakRating: intField(record, "peakRating", rating.rating),
    peakPosition: deserializePosition(record.peakPosition),
    matchesSincePromotion: intField(record, "matchesSincePromotion", 999),
    lastMatchAt:
      lastMatchAt === undefined || lastMatchAt === null ? null : Number(lastMatchAt),
  };
}

function deserializePosition(raw: unknown): LadderPosition | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("A ladder position must be an object", {});
  }
  const record = raw as Record<string, unknown>;

  const seriesRaw = record.series;
  let series: SeriesState | null = null;
  if (seriesRaw !== null && seriesRaw !== undefined) {
    if (typeof seriesRaw !== "object" || Array.isArray(seriesRaw)) {
      throw new ValidationError("A promotion series must be an object", {});
    }
    const seriesRecord = seriesRaw as Record<string, unknown>;
    series = createSeriesState({
      winsNeeded: intField(seriesRecord, "winsNeeded", 3),
      lossesAllowed: intField(seriesRecord, "lossesAllowed", 2),
      wins: intField(seriesRecord, "wins", 0),
      losses: intField(seriesRecord, "losses", 0),
    });
  }

  const tierValue = record.tier;
  if (!isTier(tierValue)) {
    throw new ValidationError("Unknown tier", { tier: String(tierValue) });
  }

  const divisionValue = record.division;
  let division: Division | null = null;
  if (divisionValue !== null && divisionValue !== undefined) {
    if (!isDivision(divisionValue)) {
      throw new ValidationError("Unknown division", { division: String(divisionValue) });
    }
    division = divisionValue;
  }

  return createLadderPosition({
    tier: tierValue,
    division,
    leaguePoints: intField(record, "leaguePoints", 0),
    series,
  });
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && Object.values(Tier).includes(value as Tier);
}

function isDivision(value: unknown): value is Division {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function intField(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${key} must be an integer`, { [key]: value });
  }
  return value;
}
