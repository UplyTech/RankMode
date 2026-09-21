/**
 * Integer arithmetic that stays exact past 2^53.
 *
 * The Python edition gets this for free: its integers do not lose precision at
 * any size. A JavaScript `number` does, above `Number.MAX_SAFE_INTEGER` — and
 * that is what made the two editions disagree, in three separate places, for
 * the whole of 1.x.
 *
 * The trap is that the *inputs* and the *answer* are both well inside the safe
 * range. Only the product in the middle is not:
 *
 * ```
 * Math.floor((cost * growthPermille) / 1000)
 * //          ^^^^^^^^^^^^^^^^^^^^^^ this can pass 2^53 while cost, the
 * //                                 growth factor and the result are all fine
 * ```
 *
 * There is no oversized value for a `Number.isSafeInteger` guard to catch,
 * which is why nothing caught it. So the arithmetic itself is done here, once,
 * and every site that used to write the pattern by hand calls this instead.
 */

/**
 * `floor(a * b / c)`, exact whatever the size of `a * b`.
 *
 * The *product* may be any size; the **answer** must still be a safe integer,
 * because that is what it is returned as. That is not a gap: an answer above
 * 2^53 is a total or a factor the shared range does not allow, and the callers
 * that can produce one — `applyMultipliers`, `combinedPermille` — raise
 * `XpOverflowError` for it rather than passing it on.
 *
 * BigInt is exact and roughly an order of magnitude slower than a `number`
 * multiplication. The fast path therefore covers every award a real bot ever
 * computes; the slow path exists so that the one that is not real is still
 * right.
 *
 * `a` and `b` must be safe integers and `c` a positive safe integer — every
 * caller in this package validates its inputs long before reaching here.
 */
export function mulDivFloor(a: number, b: number, c: number): number {
  const product = a * b;
  if (Number.isSafeInteger(product)) {
    return Math.floor(product / c);
  }

  const exact = (BigInt(a) * BigInt(b)) / BigInt(c);
  // BigInt division truncates toward zero; Python's `//` floors. They agree for
  // non-negative operands, which is every use in this package, and they must
  // not be allowed to disagree quietly if that ever changes.
  if (exact < 0n && exact * BigInt(c) !== BigInt(a) * BigInt(b)) {
    return Number(exact - 1n);
  }
  return Number(exact);
}

/**
 * `a * b` as an exact integer, or `null` when the answer itself is too large to
 * hold.
 *
 * Used where a product is checked against a ceiling rather than divided: a
 * curve that would generate a threshold outside the shared safe range has to be
 * refused, and the check has to happen on the exact value rather than on the
 * rounded one.
 */
export function mulExact(a: number, b: number): number | null {
  const product = a * b;
  if (Number.isSafeInteger(product)) {
    return product;
  }
  const exact = BigInt(a) * BigInt(b);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(exact);
}
