/**
 * @uplytech/rankmode
 *
 * Experience points, levels and leaderboards — calculated, never stored.
 *
 * One formula, one abuse guard, one behaviour, everywhere UplyTech awards
 * points. The library computes; where the points come from and where the new
 * total is written is the caller's decision.
 */

export { RankEngine, createEventRule, defaultRules, applyMultipliers, combinedPermille } from "./engine.js";
export type { AwardOptions, PenalizeOptions } from "./engine.js";

export {
  Curve,
  LinearCurve,
  QuadraticCurve,
  ExponentialCurve,
  TabularCurve,
  createCurve,
  defaultCurve,
} from "./curves.js";
export type { CurveSpec } from "./curves.js";

export {
  CryptoRandomSource,
  SeededRandomSource,
  FixedRandomSource,
} from "./random.js";
export type { RandomSource } from "./random.js";

export {
  createMemberState,
  cloneMemberState,
  serializeMemberState,
  deserializeMemberState,
  pruneMemberState,
} from "./state.js";

export { buildLeaderboard, rankOf, paginate, pageCount } from "./leaderboard.js";
export type { LeaderboardOptions } from "./leaderboard.js";

export { migrateTotalXp, migrateAll, previewMigration } from "./migration.js";
export type { MigrationReport } from "./migration.js";

export {
  MAX_TOTAL_XP,
  MIN_TOTAL_XP,
  PERMILLE_ONE,
  DEFAULT_MAX_LEVEL,
  MAX_SUPPORTED_LEVEL,
  DEFAULT_PERIOD_SECONDS,
  GLOBAL_CAP_KEY,
} from "./constants.js";

export {
  RankModeError,
  ConfigurationError,
  ValidationError,
  CurveError,
  XpOverflowError,
  MigrationError,
  LadderError,
  SeasonError,
} from "./errors.js";

export { AwardOutcome, TieMode, MigrationStrategy } from "./types.js";
export type {
  AwardResult,
  DecayRule,
  EventRule,
  EventRuleInput,
  GlobalCap,
  LeaderboardEntry,
  LeaderboardInput,
  LevelProgress,
  MemberState,
  MigrationResult,
  Multiplier,
  RankConfig,
  RankConfigInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// The ranked system: ratings, ladders, seasons, matchmaking.
// ---------------------------------------------------------------------------

export {
  SCALE,
  toFixed,
  fromFixed,
  isqrt,
  fixedMul,
  fixedDiv,
  fixedSqrt,
  fixedLn,
  fixedExp,
} from "./fixed.js";

export {
  MatchOutcome,
  RatingSystem,
  scorePermille,
  createRating,
  createEloConfig,
  createGlicko2Config,
  kFor,
  expectedScorePermille,
  updateElo,
  updateGlicko2,
  ratingInterval,
  DEFAULT_RATING,
  DEFAULT_DEVIATION,
  DEFAULT_VOLATILITY,
} from "./rating.js";
export type { Rating, EloConfig, Glicko2Config } from "./rating.js";

export {
  Tier,
  Division,
  LadderOutcome,
  tierOrder,
  isApex,
  defaultTiers,
  divisionLabel,
  createSeriesState,
  isSeriesWon,
  isSeriesLost,
  isSeriesOver,
  createLadderPosition,
  createLadderConfig,
  usesSeries,
  positionForRating,
  ratingForPosition,
  comparePositions,
  formatPosition,
  applyLeaguePoints,
} from "./ladder.js";
export type {
  SeriesState,
  LadderPosition,
  LadderConfig,
  LadderChange,
} from "./ladder.js";

export {
  ResetPolicy,
  createSeason,
  isWithin,
  createSeasonResetConfig,
  resetRating,
  resetPosition,
  winRatePermille,
  seasonFor,
} from "./season.js";
export type { Season, SeasonResetConfig, SeasonSummary } from "./season.js";

export {
  matchQuality,
  isAcceptable,
  teamRating,
  balanceTeams,
} from "./matchmaking.js";
export type { MatchQuality, TeamSplit } from "./matchmaking.js";

export {
  RankedEngine,
  createRankedConfig,
  createRankedState,
  cloneRankedState,
  serializeRankedState,
  deserializeRankedState,
} from "./ranked.js";
export type {
  RankedConfig,
  RankedState,
  MatchResult,
  SerializedPosition,
  SerializedRankedState,
} from "./ranked.js";

import { RankEngine as _RankEngine } from "./engine.js";
export default _RankEngine;
