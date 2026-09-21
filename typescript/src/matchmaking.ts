/**
 * Matchmaking: is this a fair game, and if not, who should play instead.
 *
 * The library ranks; it does not run a queue. Holding a pool of waiting players,
 * deciding when to widen the search, talking to a lobby — all of that belongs to
 * the caller, who already has the players in memory and knows what a queue means
 * in their product.
 *
 * What is here is the part that is arithmetic and easy to get wrong: how good a
 * match is, how likely each side is to win, and how to split a group of players
 * into two teams that are as close as they can be made.
 */
import { PERMILLE_ONE } from "./constants.js";
import { ValidationError } from "./errors.js";
import { SCALE, fixedDiv, fixedSqrt } from "./fixed.js";
import { type Rating, RatingSystem, expectedScorePermille } from "./rating.js";

/** How good a proposed match is. */
export interface MatchQuality {
  /**
   * 0..1000. A thousand is a coin toss between two equally certain players;
   * zero is a foregone conclusion.
   */
  readonly qualityPermille: number;
  /** The chance the first side wins, in permille. */
  readonly winProbabilityPermille: number;
  /** The rating gap, in points. Signed: positive means the first side is stronger. */
  readonly ratingGap: number;
  /**
   * True when both sides are certain enough for the quality figure to mean
   * something. A match between two players the system knows nothing about scores
   * well and tells you nothing.
   */
  readonly confident: boolean;
}

/**
 * How even a match between two players would be.
 *
 * Quality is highest when the expected score is closest to even, and it falls
 * away as the match becomes predictable. The relationship is deliberately not
 * linear: an expected score of 550 is a good match, 650 is a mediocre one and
 * 750 is not worth playing, and a linear scale would call the last of those
 * "half quality".
 *
 * Under Glicko-2 the two deviations widen the answer: pairing two players the
 * system is unsure about is a *worse* match than the ratings suggest, because
 * the ratings might be wrong. `confident` says whether that is the case.
 *
 * **The answer does not depend on which side the caller listed first**, and
 * that needs saying because it does not come for free. Glicko-2's expected
 * score damps by the *opponent's* deviation, so the two directions are two
 * different calculations that agree to within a rounding step — and the quality
 * is quadratic in the imbalance, which turns that one permille into three. A
 * queue that got a different verdict depending on the order it happened to hold
 * two players in would be a queue with a bug nobody could reproduce, so the
 * expectation is evaluated in a fixed order and flipped afterwards if the caller
 * asked the other way round.
 */
export function matchQuality(
  left: Rating,
  right: Rating,
  system: RatingSystem = RatingSystem.Glicko2,
): MatchQuality {
  const flipped = canonicalOrder(left, right);
  const first = flipped ? right : left;
  const second = flipped ? left : right;

  const canonical = expectedScorePermille(first, second, system);
  const probability = flipped ? PERMILLE_ONE - canonical : canonical;

  // Distance from an even match, 0..500. Taken from the canonical direction,
  // which is what makes it identical for both orderings.
  const imbalance = Math.abs(canonical - Math.floor(PERMILLE_ONE / 2));
  // Quality falls with the square of the imbalance, normalised so that an even
  // match is 1000 and a certain one is 0.
  let quality = PERMILLE_ONE - Math.floor((imbalance * imbalance * 4) / PERMILLE_ONE);

  if (system === RatingSystem.Glicko2) {
    // Uncertainty discounts the quality: a match that looks even between two
    // unknowns is a guess, not a good pairing.
    const combined = left.deviation + right.deviation;
    // At two full newcomer deviations the quality is halved.
    const penalty = Math.min(
      Math.floor(PERMILLE_ONE / 2),
      Math.floor((combined * PERMILLE_ONE) / (4 * 350)),
    );
    quality = Math.floor((quality * (PERMILLE_ONE - penalty)) / PERMILLE_ONE);
  }

  const confident = left.deviation <= 100 && right.deviation <= 100;

  return {
    qualityPermille: Math.max(0, Math.min(PERMILLE_ONE, quality)),
    winProbabilityPermille: probability,
    ratingGap: left.rating - right.rating,
    confident,
  };
}

/**
 * Whether the pair should be evaluated the other way round.
 *
 * Any total order will do; this one is by rating, then by the fields that break
 * a tie, and it is written out rather than left to a tuple comparison because
 * JavaScript has no tuple comparison and the Python edition has to agree with
 * whatever this does.
 */
function canonicalOrder(left: Rating, right: Rating): boolean {
  if (left.rating !== right.rating) return left.rating > right.rating;
  if (left.deviation !== right.deviation) return left.deviation > right.deviation;
  if (left.volatility !== right.volatility) return left.volatility > right.volatility;
  return left.matchesPlayed > right.matchesPlayed;
}

/**
 * Whether a match is good enough to run.
 *
 * Two gates rather than one, because they catch different things. The quality
 * gate rejects a mismatch; the rating gap gate rejects a pairing that scores
 * well only because both players are uncertain. A queue that widens over time
 * relaxes the first and keeps the second.
 */
export function isAcceptable(
  quality: MatchQuality,
  minimumQualityPermille = 400,
  maximumGap: number | null = null,
): boolean {
  if (minimumQualityPermille < 0 || minimumQualityPermille > PERMILLE_ONE) {
    throw new ValidationError("minimumQualityPermille must be between 0 and 1000", {
      minimumQualityPermille,
    });
  }
  if (quality.qualityPermille < minimumQualityPermille) {
    return false;
  }
  if (maximumGap !== null && Math.abs(quality.ratingGap) > maximumGap) {
    return false;
  }
  return true;
}

/**
 * One rating that stands in for a team.
 *
 * The mean rating, and the deviations combined the way independent
 * uncertainties combine — the root of the mean of the squares, not the mean.
 * Averaging deviations would say that five uncertain players make an uncertain
 * team; in fact their errors partly cancel, and the team is more predictable
 * than any of them.
 */
export function teamRating(members: readonly Rating[]): Rating {
  if (members.length === 0) {
    throw new ValidationError("A team needs at least one member", {});
  }

  let total = 0;
  let variance = 0;
  let volatilityTotal = 0;
  let matches = Number.POSITIVE_INFINITY;
  for (const member of members) {
    total += member.rating;
    variance += member.deviation * member.deviation;
    volatilityTotal += member.volatility;
    matches = Math.min(matches, member.matchesPlayed);
  }
  const count = members.length;

  // Round half away from zero so two teams of the same total are equal.
  const mean =
    total >= 0
      ? Math.floor((total * 2 + count) / (2 * count))
      : -Math.floor((-total * 2 + count) / (2 * count));

  const deviation = fixedSqrt(fixedDiv(variance * SCALE, count * SCALE));
  const deviationPoints = Math.floor((deviation + SCALE / 2) / SCALE);

  const volatility = Math.floor(volatilityTotal / count);

  return {
    rating: mean,
    deviation: Math.max(1, deviationPoints),
    volatility: Math.max(1, volatility),
    matchesPlayed: matches,
  };
}

/** Two teams, and how even the result is. */
export interface TeamSplit {
  /**
   * Indices into the input list, not the ratings themselves — the caller knows
   * which player each index is and this module deliberately does not.
   */
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly quality: MatchQuality;
}

/**
 * Split an even number of players into the two closest teams.
 *
 * Exhaustive over every split, which is the right algorithm for the sizes that
 * matter: ten players is 126 distinct splits, and a heuristic that is fast on
 * ten players buys nothing while occasionally producing a worse team than the
 * obvious one.
 *
 * The search is capped at 20 players (92,378 splits). Above that a caller is
 * building something this function is not for, and returning a slightly wrong
 * answer slowly would be the worst of both.
 */
export function balanceTeams(
  players: readonly Rating[],
  system: RatingSystem = RatingSystem.Glicko2,
): TeamSplit {
  const count = players.length;
  if (count < 2 || count % 2 !== 0) {
    throw new ValidationError("balanceTeams needs an even number of players, at least two", {
      count,
    });
  }
  if (count > 20) {
    throw new ValidationError("balanceTeams is exhaustive and capped at 20 players", { count });
  }

  const half = count / 2;
  let best: TeamSplit | null = null;

  // Every subset of size `half` that contains player 0, so each split is
  // considered once rather than twice with the sides swapped.
  for (let mask = 0; mask < 1 << count; mask += 1) {
    if ((mask & 1) === 0) {
      continue;
    }
    if (popcount(mask) !== half) {
      continue;
    }
    const leftIndices: number[] = [];
    const rightIndices: number[] = [];
    for (let index = 0; index < count; index += 1) {
      if (mask & (1 << index)) {
        leftIndices.push(index);
      } else {
        rightIndices.push(index);
      }
    }
    const quality = matchQuality(
      teamRating(leftIndices.map((index) => players[index] as Rating)),
      teamRating(rightIndices.map((index) => players[index] as Rating)),
      system,
    );
    if (best === null || quality.qualityPermille > best.quality.qualityPermille) {
      best = { left: leftIndices, right: rightIndices, quality };
    }
  }

  /* c8 ignore next 3 -- the loop always finds at least one split */
  if (best === null) {
    throw new ValidationError("No split could be formed", { count });
  }
  return best;
}

/** How many bits are set. Written out because JavaScript has no `bit_count`. */
function popcount(value: number): number {
  let remaining = value;
  let count = 0;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}
