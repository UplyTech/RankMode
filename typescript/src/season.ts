/**
 * Seasons: the ladder starts again, without starting from nothing.
 *
 * A competitive ladder that never resets stops being competitive. The top
 * settles into the people who played earliest, a newcomer cannot reach the top
 * bracket inside a year, and a player who stopped a season ago still occupies a
 * place.
 *
 * A ladder that resets *completely* is worse. Everybody plays their placements
 * against strangers, the matchmaker knows nothing about anybody for a week, and
 * the player who spent four months reaching Diamond opens the game to find they
 * are Silver again.
 *
 * So the reset is **soft**: the rating is pulled towards the middle by a
 * fraction, and the uncertainty is widened so the first few matches of the new
 * season count for more. A strong player lands high and confirms it in five
 * matches; a weak one lands low and does the same. Nobody starts from nothing,
 * and nobody keeps a place they can no longer hold.
 *
 * Everything here is a pure function of a state and a season definition. Nothing
 * reads a clock: a season boundary is a timestamp the caller passes in, because
 * a library that decided for itself when a season ended could not be tested.
 */
import { PERMILLE_ONE } from "./constants.js";
import { ConfigurationError, SeasonError, ValidationError } from "./errors.js";
import {
  type LadderConfig,
  type LadderPosition,
  positionForRating,
} from "./ladder.js";
import {
  DEFAULT_DEVIATION,
  DEFAULT_RATING,
  DEFAULT_VOLATILITY,
  type Rating,
} from "./rating.js";

/** How hard the reset pulls. */
export enum ResetPolicy {
  /**
   * Nothing changes. For a ladder whose season is a label rather than a
   * restart — a leaderboard that is archived and continues.
   */
  None = "NONE",
  /**
   * The rating moves a fraction of the way towards the mean, and the deviation
   * widens. The default, and what almost every ladder wants.
   */
  Soft = "SOFT",
  /**
   * Everybody returns to the starting rating with full uncertainty. Honest,
   * brutal, and worth it only when the population or the rules changed enough
   * that last season's numbers mean nothing.
   */
  Hard = "HARD",
}

/**
 * One competitive period.
 *
 * `startsAt` and `endsAt` are epoch milliseconds, like every other timestamp in
 * this library. `endsAt` may be `null` for the season that is running now and
 * has no announced end.
 */
export interface Season {
  /**
   * Stable identifier. Stored alongside a player's state so that a state from
   * an older season can be recognised and reset rather than trusted.
   */
  readonly id: string;
  /** Human name, for display. */
  readonly name: string;
  readonly startsAt: number;
  readonly endsAt: number | null;
}

export function createSeason(options: {
  id: string;
  name: string;
  startsAt: number;
  endsAt?: number | null;
}): Season {
  const season: Season = {
    id: options.id,
    name: options.name,
    startsAt: options.startsAt,
    endsAt: options.endsAt ?? null,
  };
  if (typeof season.id !== "string" || season.id.length === 0) {
    throw new ConfigurationError("A season needs a non-empty id", { id: season.id });
  }
  if (!Number.isSafeInteger(season.startsAt)) {
    throw new ConfigurationError("startsAt must be an epoch-millisecond integer", {
      startsAt: season.startsAt,
    });
  }
  if (season.endsAt !== null) {
    if (!Number.isSafeInteger(season.endsAt)) {
      throw new ConfigurationError("endsAt must be an epoch-millisecond integer or null", {
        endsAt: season.endsAt,
      });
    }
    if (season.endsAt <= season.startsAt) {
      throw new SeasonError("A season cannot end before it begins", {
        startsAt: season.startsAt,
        endsAt: season.endsAt,
      });
    }
  }
  return season;
}

/** True when the timestamp falls inside this season. */
export function isWithin(season: Season, timestamp: number): boolean {
  if (timestamp < season.startsAt) {
    return false;
  }
  return season.endsAt === null || timestamp < season.endsAt;
}

/**
 * How much of last season a player keeps.
 *
 * The defaults describe the soft reset most ladders converge on after trying the
 * alternatives: pull halfway to the mean, widen the uncertainty to about half of
 * a newcomer's, and never let anybody land more than one tier above where their
 * rating says they belong.
 */
export interface SeasonResetConfig {
  readonly policy: ResetPolicy;
  /**
   * How far towards the mean the rating moves, in permille. 500 is halfway.
   * 0 keeps the rating exactly; 1000 is a hard reset by another name.
   */
  readonly pullPermille: number;
  /** The rating the pull moves towards. */
  readonly meanRating: number;
  /**
   * The deviation every player starts the season with, in rating points. Half a
   * newcomer's, so the first matches count for more without the swings being
   * wild.
   */
  readonly resetDeviation: number;
  /**
   * Whether the volatility carries over. It usually should: a player whose
   * results were erratic last season is likely to be erratic this season, and
   * that is information worth keeping.
   */
  readonly keepVolatility: boolean;
  /**
   * Matches played resets to zero, so that placements happen again. Set to false
   * for a ladder where placements are a one-time event per account.
   */
  readonly resetMatchesPlayed: boolean;
}

export function createSeasonResetConfig(
  options: Partial<SeasonResetConfig> = {},
): SeasonResetConfig {
  const config: SeasonResetConfig = {
    policy: options.policy ?? ResetPolicy.Soft,
    pullPermille: options.pullPermille ?? 500,
    meanRating: options.meanRating ?? DEFAULT_RATING,
    resetDeviation: options.resetDeviation ?? Math.floor(DEFAULT_DEVIATION / 2),
    keepVolatility: options.keepVolatility ?? true,
    resetMatchesPlayed: options.resetMatchesPlayed ?? true,
  };
  if (config.pullPermille < 0 || config.pullPermille > PERMILLE_ONE) {
    throw new ConfigurationError("pullPermille must be between 0 and 1000", {
      pullPermille: config.pullPermille,
    });
  }
  if (config.resetDeviation <= 0) {
    throw new ConfigurationError("resetDeviation must be positive", {
      resetDeviation: config.resetDeviation,
    });
  }
  return config;
}

/**
 * Carry a rating into a new season.
 *
 * Under `Soft` the rating moves a fraction of the way to the mean and the
 * deviation is set to the season's starting value. The arithmetic is integer
 * throughout, and the rounding is half away from zero so that a player above the
 * mean and one equally far below move by the same amount.
 */
export function resetRating(rating: Rating, config?: SeasonResetConfig): Rating {
  const settings = config ?? createSeasonResetConfig();

  if (settings.policy === ResetPolicy.None) {
    return rating;
  }

  if (settings.policy === ResetPolicy.Hard) {
    return {
      rating: settings.meanRating,
      deviation: DEFAULT_DEVIATION,
      volatility: settings.keepVolatility ? rating.volatility : DEFAULT_VOLATILITY,
      matchesPlayed: settings.resetMatchesPlayed ? 0 : rating.matchesPlayed,
    };
  }

  const distance = settings.meanRating - rating.rating;
  const moved = distance * settings.pullPermille;
  const shift =
    moved >= 0
      ? Math.floor((moved + PERMILLE_ONE / 2) / PERMILLE_ONE)
      : -Math.floor((-moved + PERMILLE_ONE / 2) / PERMILLE_ONE);

  return {
    rating: rating.rating + shift,
    deviation: settings.resetDeviation,
    volatility: settings.keepVolatility ? rating.volatility : DEFAULT_VOLATILITY,
    matchesPlayed: settings.resetMatchesPlayed ? 0 : rating.matchesPlayed,
  };
}

/**
 * Where a player starts the new season on the ladder.
 *
 * Derived from the reset rating rather than carried over from last season's
 * bracket, because the bracket is a display of the rating and the rating just
 * moved. Carrying the bracket instead is how a ladder ends up with a Diamond
 * player whose rating says Gold.
 */
export function resetPosition(
  rating: Rating,
  reset?: SeasonResetConfig,
  ladder?: LadderConfig,
): LadderPosition {
  return positionForRating(resetRating(rating, reset).rating, ladder);
}

/**
 * What a player did in a season, for rewards and for the record.
 *
 * `peakPosition` is the thing rewards are almost always based on, and it is
 * deliberately not the *final* position: a player who reached Diamond in March
 * and slipped to Platinum in May earned the Diamond reward. Basing rewards on
 * the final standing instead teaches players to stop playing once they reach
 * their target, which is the opposite of what a ladder is for.
 */
export interface SeasonSummary {
  readonly seasonId: string;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly peakRating: number;
  readonly finalRating: number;
  readonly peakPosition: LadderPosition | null;
  readonly finalPosition: LadderPosition | null;
}

/**
 * Wins as a share of decided matches, in permille.
 *
 * Draws are excluded from the denominator rather than counted as half a win: a
 * win rate is read as "how often do I win when it is decided", and a ladder with
 * many draws would otherwise show everybody at 500.
 */
export function winRatePermille(summary: SeasonSummary): number {
  const decided = summary.wins + summary.losses;
  if (decided === 0) {
    return 0;
  }
  return Math.floor((summary.wins * PERMILLE_ONE) / decided);
}

/**
 * Which season a timestamp falls in, or `null` between two.
 *
 * A gap between seasons is a normal thing — the week where last season is over
 * and the next has not begun — and it is not an error. What a caller does with
 * `null` is their decision: most show last season's result and refuse ranked
 * matches.
 */
export function seasonFor(seasons: readonly Season[], timestamp: number): Season | null {
  if (!Number.isSafeInteger(timestamp)) {
    throw new ValidationError("timestamp must be an integer", { timestamp });
  }
  for (const season of seasons) {
    if (isWithin(season, timestamp)) {
      return season;
    }
  }
  return null;
}
