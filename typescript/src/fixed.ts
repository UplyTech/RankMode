/**
 * Deterministic fixed-point arithmetic.
 *
 * A rating system needs `exp`, `ln` and `sqrt`. Both editions could call the
 * ones their runtime provides — and both would be right to within a bit or two.
 * That is exactly the problem: *to within a bit or two* is how two editions end
 * up disagreeing about whether somebody got promoted.
 *
 * IEEE 754 pins down the four basic operations to the last bit; it does not pin
 * down the transcendental functions. `Math.exp` here and `math.exp` there are
 * different implementations of the same specification, free to return values
 * one unit in the last place apart — and a rating that lands one micro-unit
 * either side of a promotion threshold is a player promoted in one edition and
 * not in the other.
 *
 * So the functions live here instead, computed on integers with an algorithm
 * that has no freedom to differ.
 *
 * Everything is in **micro-units**: the integer `1_500_000` means `1.5`.
 */
import { ValidationError } from "./errors.js";

/** One, in micro-units. */
export const SCALE = 1_000_000;

/**
 * The series in both `ln` and `exp` is accumulated at a thousand times the
 * working precision and rounded once at the end. Rounding every term instead
 * costs about eight micro-units in `ln` — small, but a bias rather than noise,
 * and a bias accumulates over a season's worth of matches.
 */
const PRECISE = SCALE * 1000;

/** ln(2) at the internal precision, and half of it, for the range reduction. */
const LN2_PRECISE = 693_147_181;
const HALF_LN2_PRECISE = Math.floor(LN2_PRECISE / 2);

/**
 * A whole number as a fixed-point value.
 *
 * The `|| 0` is not decoration: `-0 * SCALE` is `-0`, and the Python edition
 * has no such value. See {@link fromFixed}.
 */
export function toFixed(value: number): number {
  return value * SCALE || 0;
}

/**
 * A fixed-point value rounded to the nearest whole number.
 *
 * Half away from zero, because half-to-even would make a rating of exactly x.5
 * round differently depending on whether x is odd — which is impossible to
 * explain to a player standing on a promotion threshold.
 *
 * **Negative zero is normalised away**, and that is a cross-edition rule rather
 * than tidiness. `fromFixed(-1)` negates a floor of zero, and in JavaScript
 * `-0` is a distinct value that `Object.is`, `1 / x` and a strict snapshot all
 * tell apart from `0`. Python has no such value, so leaving it would be a
 * number the two editions spell differently — which is the one thing this
 * library promises not to do.
 */
export function fromFixed(value: number): number {
  if (value >= 0) {
    return Math.floor((value + SCALE / 2) / SCALE);
  }
  return -Math.floor((-value + SCALE / 2) / SCALE) || 0;
}

/**
 * Floor division on BigInt, matching Python's `//`.
 *
 * BigInt division truncates towards zero; Python's `//` floors towards minus
 * infinity. They agree for positive operands and differ by one for negative
 * ones — and the Taylor series in `exp` alternates sign, so "differ by one"
 * there is the two editions returning different numbers. Written out rather
 * than assumed, because the assumption is wrong exactly where it matters.
 */
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  if (quotient * denominator !== numerator && numerator < 0n !== denominator < 0n) {
    return quotient - 1n;
  }
  return quotient;
}

/** Integer division rounded half away from zero. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new ValidationError("Division by zero in fixed-point arithmetic", {});
  }
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const magnitude = (a + b / 2n) / b;
  return negative ? -magnitude : magnitude;
}

/**
 * Integer square root: the largest `r` with `r * r <= value`.
 *
 * Newton's method on BigInt. Exact by construction — there is nothing to round
 * and therefore nothing to disagree about. BigInt rather than `number` because
 * the intermediates here reach 10^18, well past where a double is exact, and
 * this is the one place in the package where correctness costs speed.
 */
export function isqrt(value: number | bigint): number {
  const target = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (target < 0n) {
    throw new ValidationError("Square root of a negative number", { value: Number(target) });
  }
  if (target < 2n) {
    return Number(target);
  }

  // A starting point at least as large as the answer, from the bit length.
  let guess = 1n << BigInt(Math.ceil(target.toString(2).length / 2));
  for (;;) {
    const better = (guess + target / guess) / 2n;
    if (better >= guess) {
      return Number(guess);
    }
    guess = better;
  }
}

/** `a * b` in fixed point, rounded half away from zero. */
export function fixedMul(a: number, b: number): number {
  return Number(roundDiv(BigInt(a) * BigInt(b), BigInt(SCALE)));
}

/** `a / b` in fixed point, rounded half away from zero. */
export function fixedDiv(a: number, b: number): number {
  return Number(roundDiv(BigInt(a) * BigInt(SCALE), BigInt(b)));
}

/**
 * Square root of a fixed-point value.
 *
 * `sqrt(v / SCALE) * SCALE` is `sqrt(v * SCALE)`, so one integer square root
 * does the whole job — no iteration in fixed point, and therefore nothing to
 * converge differently.
 */
export function fixedSqrt(value: number): number {
  if (value < 0) {
    throw new ValidationError("Square root of a negative number", { value });
  }
  // One extra factor of a million inside the root, so the result is rounded
  // rather than truncated.
  const inner = BigInt(value) * BigInt(SCALE) * 1_000_000n;
  return Number(roundDiv(BigInt(isqrt(inner)), 1_000n));
}

/**
 * Natural logarithm of a fixed-point value. `value` must be positive.
 *
 * Range reduction to `[1, 2)` by powers of two, then the `atanh` series, which
 * converges fastest exactly where the reduced value lives:
 *
 *     ln(x) = 2 * (z + z^3/3 + z^5/5 + ...)   with z = (x - 1) / (x + 1)
 *
 * On `[1, 2)` the largest `z` is 1/3, so each term is an order of magnitude
 * smaller than the one before.
 */
export function fixedLn(value: number): number {
  if (value <= 0) {
    throw new ValidationError("Logarithm of a non-positive number", { value });
  }

  let exponent = 0;
  let reduced = value;
  while (reduced >= 2 * SCALE) {
    reduced = Math.floor(reduced / 2);
    exponent += 1;
  }
  while (reduced < SCALE) {
    reduced *= 2;
    exponent -= 1;
  }

  const precise = BigInt(PRECISE);
  const x = BigInt(reduced) * 1000n;
  const z = roundDiv((x - precise) * precise, x + precise);
  const zSquared = roundDiv(z * z, precise);

  let total = z;
  let term = z;
  for (let denominator = 3; denominator < 60; denominator += 2) {
    term = roundDiv(term * zSquared, precise);
    if (term === 0n) {
      break;
    }
    total += floorDiv(term, BigInt(denominator));
  }

  return Number(roundDiv(2n * total + BigInt(exponent) * BigInt(LN2_PRECISE), 1000n));
}

/**
 * `e` to the power of a fixed-point value.
 *
 * Range reduction by `ln 2` to `[-ln2/2, ln2/2]`, then the Taylor series. On
 * that interval the argument is below 0.35, so the terms fall away fast.
 *
 * The domain is limited to `|value| <= 20`. Two limits meet there: `e^20` is
 * half a billion, which a rating system reaching it has bigger problems than,
 * and `e^-20` is two billionths, which micro-units cannot represent at all — it
 * returns zero, and that is the honest answer rather than a rounding artefact.
 */
export function fixedExp(value: number): number {
  const limit = 20 * SCALE;
  if (value > limit || value < -limit) {
    throw new ValidationError("Exponent outside the supported range of +/- 20", { value });
  }

  const precise = BigInt(PRECISE);
  const ln2 = BigInt(LN2_PRECISE);
  const half = BigInt(HALF_LN2_PRECISE);
  const argument = BigInt(value) * 1000n;

  const k = argument >= 0n ? (argument + half) / ln2 : -((-argument + half) / ln2);
  const remainder = argument - k * ln2;

  let total = precise;
  let term = precise;
  for (let n = 1n; n < 25n; n += 1n) {
    term = floorDiv(roundDiv(term * remainder, precise), n);
    if (term === 0n) {
      break;
    }
    total += term;
  }

  // Multiplying by 2^k rather than shifting the result: a shift on the way down
  // throws away the bits that carry the answer.
  const scaled = k >= 0n ? total << k : roundDiv(total, 1n << -k);
  return Number(roundDiv(scaled, 1000n));
}
