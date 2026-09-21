/**
 * Values that both language editions must agree on, byte for byte.
 *
 * Changing anything in here changes the level of existing members and is
 * therefore always a major version — see CHANGELOG.md.
 */

/**
 * Largest total that RankMode will ever produce.
 *
 * This is `2^53 - 1`, the largest integer JavaScript can represent exactly.
 * Python could go further, but a total that only one edition can hold would
 * break the "identical results in both editions" guarantee, so both clamp here.
 */
export const MAX_TOTAL_XP = 9007199254740991;

/** Smallest total that RankMode will ever produce when negatives are allowed. */
export const MIN_TOTAL_XP = -9007199254740991;

/** `1000` permille = factor 1.0. All multipliers are integers to stay exact. */
export const PERMILLE_ONE = 1000;

/** Default highest level a generated curve will contain. */
export const DEFAULT_MAX_LEVEL = 1000;

/** Upper bound for `maxLevel`, to keep threshold tables a sane size. */
export const MAX_SUPPORTED_LEVEL = 10000;

/** Default length of a capping period: 24 hours. */
export const DEFAULT_PERIOD_SECONDS = 86400;

/** Key used for the cross-event global cap inside the member state maps. */
export const GLOBAL_CAP_KEY = "*";
