/**
 * Skill ratings: what a player is worth, as a number.
 *
 * Two systems ship, and the choice between them is a real one rather than a
 * preference:
 *
 * **Elo** is one number and one formula. Everybody understands it, it is cheap,
 * and it has one weakness that matters: it treats a player who has played four
 * matches exactly like one who has played four hundred.
 *
 * **Glicko-2** carries the missing piece: how *sure* the system is. An uncertain
 * player moves fast, a settled one moves slowly, and a player who stops playing
 * becomes uncertain again on their own.
 *
 * **Glicko-2 is the default.** Elo is here for the caller who needs a number a
 * player can compute in their head.
 *
 * Everything is integers, through `./fixed.js` — a rating system in floating
 * point would give the two editions two different answers, and this library's
 * whole promise is that it does not.
 */
import { PERMILLE_ONE } from "./constants.js";
import { ConfigurationError, ValidationError } from "./errors.js";
import { SCALE, fixedDiv, fixedExp, fixedLn, fixedMul, fixedSqrt, fromFixed } from "./fixed.js";

/** Where a player starts. The convention every rating system inherited from Elo. */
export const DEFAULT_RATING = 1500;

/** How unsure the system is about a newcomer, in rating points. Glickman's figure. */
export const DEFAULT_DEVIATION = 350;

/** How erratic a player's results are, in micro-units. Glickman's recommendation. */
export const DEFAULT_VOLATILITY = 60_000;

/** 400 / ln(10), in micro-units: between the visible scale and Glicko-2's. */
const GLICKO_SCALE = 173_717_793;

/** 3 / pi^2, in micro-units. Appears in the g(phi) damping term. */
const THREE_OVER_PI_SQUARED = 303_963;

const CONVERGENCE = 1;
const MAX_ITERATIONS = 100;

/**
 * The largest estimated variance the update will carry, in micro-units.
 *
 * Glicko-2's `v` is `1 / sum(g^2 E (1 - E))`, and when a result was very
 * improbable - a 200-rated player beating a 2200-rated one - `E` is about one in
 * a hundred thousand and the sum collapses to a handful of micro-units. The
 * reciprocal then reaches a million, `delta` follows it, and `delta^2` reaches
 * 10^18: a hundred times past `Number.MAX_SAFE_INTEGER`, which is exactly where
 * this edition would start returning numbers the Python one does not.
 *
 * Ten thousand is far outside anything a real population produces - a settled
 * player sits near 0.2 - and it is the honest ceiling: above it the estimate
 * carries no usable information, and capping says so rather than pretending the
 * arithmetic still means something.
 */
const MAX_VARIANCE = 10_000 * SCALE;

/**
 * Floor division on plain integers, matching Python's `//`.
 *
 * `Math.trunc` rounds towards zero; Python floors towards minus infinity. The
 * volatility solver works on `ln(sigma^2)`, which is about -5.6 for any sane
 * volatility - every division in it is on a negative number, and every one of
 * them would differ by one between the editions without this.
 */
function floorDiv(numerator: number, denominator: number): number {
  return Math.floor(numerator / denominator);
}

/** How a match ended, from one player's point of view. */
export enum MatchOutcome {
  Win = "WIN",
  Loss = "LOSS",
  /** Neither won. Counts as half a win in every formula here. */
  Draw = "DRAW",
}

/** The outcome as a score in permille: 1000, 0 or 500. */
export function scorePermille(outcome: MatchOutcome): number {
  if (outcome === MatchOutcome.Win) return PERMILLE_ONE;
  if (outcome === MatchOutcome.Loss) return 0;
  return Math.floor(PERMILLE_ONE / 2);
}

/** Which formula an engine uses. */
export enum RatingSystem {
  Elo = "ELO",
  Glicko2 = "GLICKO2",
}

/**
 * A player's skill, and how sure the system is about it.
 *
 * `rating` and `deviation` are whole rating points, because those are the
 * numbers a caller displays and stores. `volatility` is in micro-units, because
 * it is never displayed and a whole number would be far too coarse.
 */
export interface Rating {
  readonly rating: number;
  readonly deviation: number;
  readonly volatility: number;
  readonly matchesPlayed: number;
}

/** A rating for a player who has not been rated yet, or a known one. */
export function createRating(options: Partial<Rating> = {}): Rating {
  const rating: Rating = {
    rating: options.rating ?? DEFAULT_RATING,
    deviation: options.deviation ?? DEFAULT_DEVIATION,
    volatility: options.volatility ?? DEFAULT_VOLATILITY,
    matchesPlayed: options.matchesPlayed ?? 0,
  };
  for (const [name, value] of Object.entries(rating)) {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError(`${name} must be an integer`, { [name]: value });
    }
  }
  if (rating.deviation < 0) {
    throw new ValidationError("deviation cannot be negative", { deviation: rating.deviation });
  }
  if (rating.volatility <= 0) {
    throw new ValidationError("volatility must be positive", { volatility: rating.volatility });
  }
  if (rating.matchesPlayed < 0) {
    throw new ValidationError("matchesPlayed cannot be negative", {
      matchesPlayed: rating.matchesPlayed,
    });
  }
  return rating;
}

/**
 * The K-factor schedule.
 *
 * K decides how far one match can move a rating. One value for everybody is the
 * classic mistake: too high and every veteran's rating jitters, too low and a
 * newcomer takes fifty matches to reach where they belong.
 */
export interface EloConfig {
  readonly placementK: number;
  readonly standardK: number;
  readonly eliteK: number;
  readonly placementMatches: number;
  readonly eliteThreshold: number;
  readonly floor: number;
  readonly ceiling: number;
}

export function createEloConfig(options: Partial<EloConfig> = {}): EloConfig {
  const config: EloConfig = {
    placementK: options.placementK ?? 40,
    standardK: options.standardK ?? 20,
    eliteK: options.eliteK ?? 10,
    placementMatches: options.placementMatches ?? 10,
    eliteThreshold: options.eliteThreshold ?? 2400,
    floor: options.floor ?? 0,
    ceiling: options.ceiling ?? 5000,
  };
  for (const name of ["placementK", "standardK", "eliteK"] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) {
      throw new ConfigurationError(`${name} must be a positive integer`, {
        [name]: config[name],
      });
    }
  }
  if (config.placementMatches < 0) {
    throw new ConfigurationError("placementMatches cannot be negative", {
      placementMatches: config.placementMatches,
    });
  }
  if (config.floor >= config.ceiling) {
    throw new ConfigurationError("floor must be below ceiling", {
      floor: config.floor,
      ceiling: config.ceiling,
    });
  }
  return config;
}

/** The K-factor that applies to this player right now. */
export function kFor(rating: Rating, config: EloConfig): number {
  if (rating.matchesPlayed < config.placementMatches) return config.placementK;
  if (rating.rating >= config.eliteThreshold) return config.eliteK;
  return config.standardK;
}

/** The two numbers Glicko-2 needs beyond the rating itself. */
export interface Glicko2Config {
  /** The system constant tau, in micro-units. Caps how fast volatility moves. */
  readonly tau: number;
  readonly maxDeviation: number;
  readonly minDeviation: number;
  readonly floor: number;
  readonly ceiling: number;
  /**
   * The bounds on volatility itself, in micro-units. Glickman leaves sigma
   * unbounded; every implementation that runs against a real population puts
   * bounds on it, because a single improbable result otherwise sends it
   * somewhere no later match brings it back from. 0.001 to 0.5 is wide enough
   * that a normal ladder never touches either end.
   */
  readonly minVolatility: number;
  readonly maxVolatility: number;
}

export function createGlicko2Config(options: Partial<Glicko2Config> = {}): Glicko2Config {
  const config: Glicko2Config = {
    tau: options.tau ?? 500_000,
    maxDeviation: options.maxDeviation ?? DEFAULT_DEVIATION,
    minDeviation: options.minDeviation ?? 30,
    floor: options.floor ?? 0,
    ceiling: options.ceiling ?? 5000,
    minVolatility: options.minVolatility ?? 1_000,
    maxVolatility: options.maxVolatility ?? 500_000,
  };
  if (config.tau <= 0) {
    throw new ConfigurationError("tau must be positive", { tau: config.tau });
  }
  if (config.minVolatility <= 0) {
    throw new ConfigurationError("minVolatility must be positive", {
      minVolatility: config.minVolatility,
    });
  }
  if (config.minVolatility > config.maxVolatility) {
    throw new ConfigurationError("minVolatility cannot exceed maxVolatility", {
      minVolatility: config.minVolatility,
      maxVolatility: config.maxVolatility,
    });
  }
  if (config.minDeviation <= 0) {
    throw new ConfigurationError("minDeviation must be positive", {
      minDeviation: config.minDeviation,
    });
  }
  if (config.minDeviation > config.maxDeviation) {
    throw new ConfigurationError("minDeviation cannot exceed maxDeviation", {
      minDeviation: config.minDeviation,
      maxDeviation: config.maxDeviation,
    });
  }
  if (config.floor >= config.ceiling) {
    throw new ConfigurationError("floor must be below ceiling", {
      floor: config.floor,
      ceiling: config.ceiling,
    });
  }
  return config;
}

// ---------------------------------------------------------------------------
// Expected score
// ---------------------------------------------------------------------------

/**
 * The chance the player beats the opponent, in permille.
 *
 * Permille rather than a float for the same reason progress is: a probability
 * is displayed, compared and stored, and a float would let two editions
 * disagree in the last digit of something a player sees.
 *
 * Under Glicko-2 the opponent's *deviation* widens the answer towards 500: an
 * uncertain opponent is closer to a coin toss than their rating alone suggests.
 */
export function expectedScorePermille(
  player: Rating,
  opponent: Rating,
  system: RatingSystem = RatingSystem.Glicko2,
): number {
  const difference = opponent.rating - player.rating;

  if (system === RatingSystem.Elo) {
    let exponent = fixedDiv(difference * SCALE, 400 * SCALE);
    exponent = fixedMul(exponent, 2_302_585); // ln(10)
    return logisticPermille(exponent);
  }

  const phi = fixedDiv(opponent.deviation * SCALE, GLICKO_SCALE);
  const g = gOfPhi(phi);
  const muDifference = fixedDiv(difference * SCALE, GLICKO_SCALE);
  return logisticPermille(fixedMul(g, muDifference));
}

/** `1 / (1 + e^exponent)` as permille, clamped into 0..1000. */
function logisticPermille(exponent: number): number {
  if (exponent >= 20 * SCALE) return 0;
  if (exponent <= -20 * SCALE) return PERMILLE_ONE;
  const probability = fixedDiv(SCALE, SCALE + fixedExp(exponent));
  const permille = Math.floor((probability * PERMILLE_ONE + SCALE / 2) / SCALE);
  return Math.max(0, Math.min(PERMILLE_ONE, permille));
}

/**
 * Glicko-2's `g`: how much an uncertain opponent damps the expectation.
 *
 * At phi = 0 it is 1 — a perfectly known opponent tells you everything. As phi
 * grows it falls towards zero, and the expected score is pulled towards a coin
 * toss.
 */
function gOfPhi(phi: number): number {
  const phiSquared = fixedMul(phi, phi);
  const inner = SCALE + fixedMul(THREE_OVER_PI_SQUARED, phiSquared);
  return fixedDiv(SCALE, fixedSqrt(inner));
}

// ---------------------------------------------------------------------------
// Elo
// ---------------------------------------------------------------------------

/**
 * One Elo update, for one match against one opponent.
 *
 * `new = old + K * (score - expected)`, with everything in permille until the
 * final rounding so that the two editions round once, in the same place, on the
 * same number.
 */
export function updateElo(
  player: Rating,
  opponent: Rating,
  outcome: MatchOutcome,
  config?: EloConfig,
): Rating {
  const settings = config ?? createEloConfig();
  const k = kFor(player, settings);
  const expected = expectedScorePermille(player, opponent, RatingSystem.Elo);
  const deltaPermille = k * (scorePermille(outcome) - expected);

  // Round half away from zero, so a gain and the matching loss are symmetric.
  const delta =
    deltaPermille >= 0
      ? Math.floor((deltaPermille + PERMILLE_ONE / 2) / PERMILLE_ONE)
      : -Math.floor((-deltaPermille + PERMILLE_ONE / 2) / PERMILLE_ONE);

  return {
    ...player,
    rating: Math.max(settings.floor, Math.min(settings.ceiling, player.rating + delta)),
    matchesPlayed: player.matchesPlayed + 1,
  };
}

// ---------------------------------------------------------------------------
// Glicko-2
// ---------------------------------------------------------------------------

/**
 * A Glicko-2 update over a rating period.
 *
 * Glicko-2 is defined over a *period*, not a match: the player's results since
 * the last update are applied together. A caller who updates per match passes a
 * single result and gets the same behaviour, slightly noisier — which is the
 * trade every implementation makes.
 *
 * An empty `results` list is not an error. It is the case Glicko-2 has an answer
 * for that Elo does not: a player who did not play gets no rating change and a
 * *wider* deviation, because the system knows less about them than it did.
 */
export function updateGlicko2(
  player: Rating,
  results: readonly (readonly [Rating, MatchOutcome])[],
  config?: Glicko2Config,
): Rating {
  const settings = config ?? createGlicko2Config();

  if (results.length === 0) {
    return decayDeviation(player, settings);
  }

  const mu = fixedDiv((player.rating - DEFAULT_RATING) * SCALE, GLICKO_SCALE);
  const phi = fixedDiv(player.deviation * SCALE, GLICKO_SCALE);
  const sigma = player.volatility;

  let varianceInverse = 0;
  let deltaSum = 0;
  for (const [opponent, outcome] of results) {
    const opponentMu = fixedDiv((opponent.rating - DEFAULT_RATING) * SCALE, GLICKO_SCALE);
    const opponentPhi = fixedDiv(opponent.deviation * SCALE, GLICKO_SCALE);
    const g = gOfPhi(opponentPhi);
    const expected = expectedInternal(mu, opponentMu, g);
    const gSquared = fixedMul(g, g);
    varianceInverse += fixedMul(gSquared, fixedMul(expected, SCALE - expected));
    const score = Math.floor((scorePermille(outcome) * SCALE) / PERMILLE_ONE);
    deltaSum += fixedMul(g, score - expected);
  }

  if (varianceInverse <= 0) {
    // Every opponent was so far away that `E` rounded to zero or one, and the
    // sum carries no information at all. The rating cannot move and the
    // deviation still widens, because time passed — but the matches were
    // played, so they are counted. Dropping them here would leave a player who
    // only ever met opponents from the far end of the ladder stuck on zero
    // matches for ever.
    return decayDeviation(player, settings, results.length);
  }

  const variance = Math.min(MAX_VARIANCE, fixedDiv(SCALE, varianceInverse));
  const delta = fixedMul(variance, deltaSum);

  const sigmaNew = solveVolatility(
    sigma,
    phi,
    variance,
    delta,
    settings.tau,
    settings.minVolatility,
    settings.maxVolatility,
  );

  const phiStar = fixedSqrt(fixedMul(phi, phi) + fixedMul(sigmaNew, sigmaNew));
  const phiNew = fixedDiv(
    SCALE,
    fixedSqrt(fixedDiv(SCALE, fixedMul(phiStar, phiStar)) + varianceInverse),
  );

  const muNew = mu + fixedMul(fixedMul(phiNew, phiNew), deltaSum);

  const rating = DEFAULT_RATING + fromFixed(fixedMul(muNew, GLICKO_SCALE));
  const deviation = fromFixed(fixedMul(phiNew, GLICKO_SCALE));

  return {
    rating: Math.max(settings.floor, Math.min(settings.ceiling, rating)),
    deviation: Math.max(settings.minDeviation, Math.min(settings.maxDeviation, deviation)),
    volatility: sigmaNew,
    matchesPlayed: player.matchesPlayed + results.length,
  };
}

/** `E` on the internal scale, as a fixed-point value in 0..1. */
function expectedInternal(mu: number, opponentMu: number, g: number): number {
  const exponent = -fixedMul(g, mu - opponentMu);
  if (exponent >= 20 * SCALE) return 0;
  if (exponent <= -20 * SCALE) return SCALE;
  return fixedDiv(SCALE, SCALE + fixedExp(exponent));
}

/**
 * A rating period the player sat out.
 *
 * The rating does not move — nothing happened to move it. The deviation grows,
 * because the system's knowledge is a month older than it was. This is what
 * makes a returning player's first few matches count for more, and why Glicko-2
 * needs no separate "rust" rule.
 *
 * **The growth is forced to at least one point**, and that is not a rounding
 * nicety. `phi* = sqrt(phi^2 + sigma^2)` is computed from the deviation as it is
 * stored, in whole rating points, and once the deviation is large enough one
 * period's growth is under half a point: it rounds back to the number it started
 * from, and that number becomes a fixed point of the iteration. At the default
 * volatility that happens at 109, so without this an idle player's deviation
 * climbed for forty-nine periods and then stopped for ever — a player gone for
 * two years would still be treated as one the system knew to within a hundred
 * points, which is the opposite of what the decay is for.
 */
function decayDeviation(player: Rating, config: Glicko2Config, matches = 0): Rating {
  const phi = fixedDiv(player.deviation * SCALE, GLICKO_SCALE);
  const sigma = player.volatility;
  const phiStar = fixedSqrt(fixedMul(phi, phi) + fixedMul(sigma, sigma));
  let deviation = fromFixed(fixedMul(phiStar, GLICKO_SCALE));

  // An idle period leaves the system strictly less certain than it was, so when
  // the arithmetic rounds that to nothing the deviation still moves.
  if (deviation <= player.deviation && player.deviation < config.maxDeviation) {
    deviation = player.deviation + 1;
  }

  return {
    ...player,
    deviation: Math.max(config.minDeviation, Math.min(config.maxDeviation, deviation)),
    matchesPlayed: player.matchesPlayed + matches,
  };
}

/**
 * Glickman's volatility iteration, by bisection on his function.
 *
 * Glickman specifies the Illinois variant of regula falsi, and in floating point
 * that is the right choice. In fixed point it does not converge at all for some
 * inputs: the secant step is computed on integers, and once the bracket is
 * narrow the rounding sends it to the same two points for ever - a two-cycle no
 * iteration count escapes.
 *
 * So the root is found by bisection instead. Slower, and with the property that
 * matters more here: on integers it *always* terminates, in a number of steps
 * that follows from the bracket width alone. Both editions therefore take the
 * same number of steps and land on the same integer.
 *
 * **The bracket is clamped into the volatility bounds**, and that clamp is
 * load-bearing rather than defensive. Glickman's upper end is
 * `ln(delta^2 - phi^2 - v)`, and after a sufficiently improbable result - a
 * 200-rated player beating a 2200-rated one - `delta` reaches six figures and
 * that logarithm passes 22, outside the domain where `fixedExp` is defined at
 * all. Clamping it to `ln(maxVolatility^2)` keeps every evaluation inside the
 * representable range, and when the root genuinely lies beyond the clamp the
 * answer is the bound itself, which is what a volatility ceiling is for.
 */
function solveVolatility(
  sigma: number,
  phi: number,
  variance: number,
  delta: number,
  tau: number,
  minVolatility: number,
  maxVolatility: number,
): number {
  let a = lnFixed(fixedMul(sigma, sigma));
  const deltaSquared = fixedMul(delta, delta);
  const phiSquared = fixedMul(phi, phi);
  const tauSquared = fixedMul(tau, tau);

  // The log-variance window the answer is allowed to live in. Everything the
  // iteration evaluates is clamped into it, so `fixedExp` is never handed an
  // argument it cannot represent.
  const lowerBound = lnFixed(fixedMul(minVolatility, minVolatility));
  const upperBound = lnFixed(fixedMul(maxVolatility, maxVolatility));

  const clamp = (x: number): number => Math.max(lowerBound, Math.min(upperBound, x));

  const f = (x: number): number => {
    const expX = fixedExp(x);
    const denominator = phiSquared + variance + expX;
    const numerator = fixedMul(expX, deltaSquared - denominator);
    const first = fixedDiv(numerator, 2 * fixedMul(denominator, denominator));
    const second = fixedDiv(x - a, tauSquared);
    return first - second;
  };

  const volatilityAt = (x: number): number =>
    Math.max(minVolatility, Math.min(maxVolatility, fixedExp(floorDiv(clamp(x), 2))));

  a = clamp(a);
  let low = a;
  let high: number;

  // The bracket, as Glickman defines it, held inside the window.
  if (deltaSquared > phiSquared + variance) {
    high = clamp(lnFixed(deltaSquared - phiSquared - variance));
  } else {
    let k = 1;
    high = clamp(a - tau);
    while (high > lowerBound && f(high) < 0) {
      k += 1;
      if (k > MAX_ITERATIONS) {
        throw new ValidationError("The volatility iteration could not be bracketed", {
          sigma,
          phi,
        });
      }
      high = clamp(a - k * tau);
    }
  }

  let fLow = f(low);
  let fHigh = f(high);

  // A bracket needs opposite signs. If one end is already the root, take it.
  if (fLow === 0) return volatilityAt(low);
  if (fHigh === 0) return volatilityAt(high);
  if (fLow > 0 === fHigh > 0) {
    // The root lies outside the window. `f` falls towards minus infinity as x
    // grows, so a pair of positive values means the crossing is above the window
    // and a pair of negative ones means it is below: either way the answer is
    // the end of the window it lies beyond.
    return volatilityAt(fLow > 0 ? Math.max(low, high) : Math.min(low, high));
  }

  // Order the bracket so that `low` is the end with the negative value.
  if (fLow > 0) {
    [low, high] = [high, low];
    [fLow, fHigh] = [fHigh, fLow];
  }

  for (let step = 0; step < MAX_ITERATIONS; step += 1) {
    if (Math.abs(high - low) <= CONVERGENCE) break;
    const middle = floorDiv(low + high, 2);
    if (middle === low || middle === high) break;
    const fMiddle = f(middle);
    if (fMiddle === 0) {
      low = middle;
      high = middle;
      break;
    }
    if (fMiddle < 0) {
      low = middle;
      fLow = fMiddle;
    } else {
      high = middle;
      fHigh = fMiddle;
    }
  }

  // The midpoint of the final bracket, so the answer does not favour whichever
  // end happened to be evaluated last.
  return volatilityAt(floorDiv(low + high, 2));
}

/** `ln` of a fixed-point value, guarding the degenerate input. */
function lnFixed(value: number): number {
  if (value <= 0) {
    throw new ValidationError("Logarithm of a non-positive value", { value });
  }
  return fixedLn(value);
}

/**
 * The range the player's true skill is probably in.
 *
 * The number a rating system is actually asked for. "1500" is a point estimate
 * nobody should trust on its own; "1500, and we are 95 % sure it is between 1240
 * and 1760" is what a placement screen should say.
 */
export function ratingInterval(
  rating: Rating,
  confidencePermille = 950,
): readonly [number, number] {
  const multipliers: Record<number, number> = {
    680: 1_000_000,
    900: 1_644_854,
    950: 1_959_964,
    990: 2_575_829,
  };
  const multiplier = multipliers[confidencePermille];
  if (multiplier === undefined) {
    throw new ValidationError("confidencePermille must be one of 680, 900, 950 or 990", {
      confidencePermille,
    });
  }
  const halfWidth = fromFixed(fixedMul(multiplier, rating.deviation * SCALE));
  return [rating.rating - halfWidth, rating.rating + halfWidth];
}
