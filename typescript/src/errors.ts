/**
 * Error hierarchy for @uplytech/rankmode.
 *
 * Every error extends {@link RankModeError} so callers can catch a single
 * base class and still tell the causes apart via `code`.
 *
 * Note the design rule from the concept: the *normal* cases are results,
 * not exceptions. An active cooldown, an exhausted period cap or an unknown
 * event type all come back as an {@link AwardOutcome}. Errors are reserved
 * for programming mistakes: bad configuration, invalid input, overflow.
 */

/** Base class for every error thrown by this package. */
export class RankModeError extends Error {
  public readonly code: string;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: { code: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** The engine, a curve or a rule was configured with impossible values. */
export class ConfigurationError extends RankModeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "CONFIGURATION_ERROR", details });
  }
}

/** A call-site argument was invalid (negative XP, NaN, non-integer, ...). */
export class ValidationError extends RankModeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "VALIDATION_ERROR", details });
  }
}

/** A curve could not answer the question (level out of range, broken table). */
export class CurveError extends RankModeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "CURVE_ERROR", details });
  }
}

/** A total would leave the safe integer range shared by Python and TypeScript. */
export class XpOverflowError extends RankModeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "XP_OVERFLOW", details });
  }
}

/** A curve migration cannot be carried out with the requested strategy. */
export class MigrationError extends RankModeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "MIGRATION_ERROR", details });
  }
}

/** A ladder position or transition is impossible (apex tier with a division, ...). */
export class LadderError extends RankModeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "LADDER_ERROR", details });
  }
}

/** A season definition or boundary does not make sense. */
export class SeasonError extends RankModeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "SEASON_ERROR", details });
  }
}
