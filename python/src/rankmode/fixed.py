"""Deterministic fixed-point arithmetic.

A rating system needs ``exp``, ``ln`` and ``sqrt``. Both editions could simply
call the ones their runtime provides -- and both would be right to within a bit
or two. That is exactly the problem: *to within a bit or two* is how two
editions end up disagreeing about whether somebody got promoted.

The C library behind ``math.exp`` and the one behind ``Math.exp`` are different
implementations of the same specification. IEEE 754 pins down the four basic
operations to the last bit; it does not pin down the transcendental functions.
Two runtimes may legitimately return values one unit in the last place apart,
and a rating that lands one micro-unit either side of a promotion threshold is
a player who was promoted in one edition and not in the other.

So the functions live here instead, computed on integers with an algorithm that
has no freedom to differ. They are slower than the built-ins by roughly an order
of magnitude, and that is the price of the guarantee -- a match is recorded a
few dozen times a second at most, and a run of the whole differential harness
still finishes in seconds.

Everything is in **micro-units**: the integer ``1_500_000`` means ``1.5``.
``SCALE`` is exposed so a caller never has to write the constant out.

The accuracy is pinned by tests rather than promised here: every function is
checked against the exact value to within one micro-unit across its documented
domain, and against the other edition by the shared vectors.
"""

from __future__ import annotations

from .errors import ValidationError

__all__ = [
    "SCALE",
    "to_fixed",
    "from_fixed",
    "fixed_mul",
    "fixed_div",
    "fixed_sqrt",
    "fixed_ln",
    "fixed_exp",
    "isqrt",
]

#: One, in micro-units. Six decimal digits is more than a rating system can
#: use: the visible numbers are whole rating points, and the internal Glicko-2
#: scale is about 1/173 of a rating point.
SCALE = 1_000_000

#: The largest magnitude any intermediate is allowed to reach. Well inside the
#: shared safe integer range, so that a TypeScript ``number`` holds every
#: intermediate exactly without needing BigInt on the hot path.
_MAX_FIXED = 9_000_000_000_000  # 9e6 in micro-units

#: The series in both ``ln`` and ``exp`` is accumulated at a thousand times the
#: working precision and rounded once at the end. Rounding every term instead
#: costs about eight micro-units in ``ln`` -- small, but it is a bias rather
#: than noise, and a bias accumulates over a season's worth of matches.
_PRECISE = SCALE * 1000

#: ln(2), at the internal precision.
_LN2_PRECISE = 693_147_181  # 0.693147180559945..., at _PRECISE

#: ln(2) at the working precision, for the caller-visible result.

#: Half of ln(2), for choosing the range-reduction factor in ``exp``.
_HALF_LN2_PRECISE = _LN2_PRECISE // 2


def to_fixed(value: int) -> int:
    """A whole number as a fixed-point value."""
    return value * SCALE


def from_fixed(value: int) -> int:
    """A fixed-point value rounded to the nearest whole number.

    Half away from zero, because half-to-even would make a rating of exactly
    x.5 round differently depending on whether x is odd -- which is impossible
    to explain to a player standing on a promotion threshold.
    """
    if value >= 0:
        return (value + SCALE // 2) // SCALE
    return -((-value + SCALE // 2) // SCALE)


def _round_div(numerator: int, denominator: int) -> int:
    """Integer division rounded half away from zero."""
    if denominator == 0:
        raise ValidationError("Division by zero in fixed-point arithmetic")
    negative = (numerator < 0) != (denominator < 0)
    magnitude = (abs(numerator) + abs(denominator) // 2) // abs(denominator)
    return -magnitude if negative else magnitude


def isqrt(value: int) -> int:
    """Integer square root: the largest ``r`` with ``r * r <= value``.

    Newton's method on integers. Exact by construction -- there is no rounding
    to disagree about, which is the whole reason it is written out rather than
    delegated to ``math.isqrt`` (which Python has and JavaScript does not).
    """
    if value < 0:
        raise ValidationError("Square root of a negative number", value=value)
    if value < 2:
        return value

    # A starting point at least as large as the answer, from the bit length.
    guess = 1 << ((value.bit_length() + 1) // 2)
    while True:
        better = (guess + value // guess) // 2
        if better >= guess:
            return guess
        guess = better


def fixed_mul(a: int, b: int) -> int:
    """``a * b`` in fixed point, rounded half away from zero."""
    return _round_div(a * b, SCALE)


def fixed_div(a: int, b: int) -> int:
    """``a / b`` in fixed point, rounded half away from zero."""
    return _round_div(a * SCALE, b)


def fixed_sqrt(value: int) -> int:
    """Square root of a fixed-point value.

    ``sqrt(v / SCALE) * SCALE`` is ``sqrt(v * SCALE)``, so one integer square
    root does the whole job -- no iteration in fixed point, and therefore
    nothing to converge differently.
    """
    if value < 0:
        raise ValidationError("Square root of a negative number", value=value)
    # One extra factor of a million inside the root, so the result is rounded
    # rather than truncated: isqrt(v * SCALE * 10^6) / 10^3.
    return _round_div(isqrt(value * SCALE * 1_000_000), 1_000)


def fixed_ln(value: int) -> int:
    """Natural logarithm of a fixed-point value. ``value`` must be positive.

    Range reduction to ``[1, 2)`` by powers of two, then the ``atanh`` series,
    which converges fastest exactly where the reduced value lives::

        ln(x) = 2 * (z + z^3/3 + z^5/5 + ...)   with z = (x - 1) / (x + 1)

    On ``[1, 2)`` the largest ``z`` is 1/3, so ``z^2`` is at most 1/9 and each
    term is an order of magnitude smaller than the one before. The loop stops
    when a term falls below the internal precision, which happens well before
    the bound.
    """
    if value <= 0:
        raise ValidationError("Logarithm of a non-positive number", value=value)

    # Reduce to [SCALE, 2 * SCALE) and remember how many halvings it took.
    exponent = 0
    reduced = value
    while reduced >= 2 * SCALE:
        reduced //= 2
        exponent += 1
    while reduced < SCALE:
        reduced *= 2
        exponent -= 1

    # From here on at the internal precision.
    x = reduced * 1000
    z = _round_div((x - _PRECISE) * _PRECISE, x + _PRECISE)
    z_squared = _round_div(z * z, _PRECISE)

    total = z
    term = z
    for denominator in range(3, 60, 2):
        term = _round_div(term * z_squared, _PRECISE)
        if term == 0:
            break
        total += term // denominator

    return _round_div(2 * total + exponent * _LN2_PRECISE, 1000)


def fixed_exp(value: int) -> int:
    """``e`` to the power of a fixed-point value.

    Range reduction by ``ln 2`` to ``[-ln2/2, ln2/2]``, then the Taylor series.
    On that interval the argument is below 0.35, so the terms fall away fast.

    The domain is limited to ``|value| <= 20``. Two different limits meet there:
    ``e^20`` is half a billion, which a rating system reaching it has bigger
    problems than, and ``e^-20`` is two billionths, which micro-units cannot
    represent at all -- it returns zero, and that is the honest answer rather
    than a rounding artefact.
    """
    limit = 20 * SCALE
    if value > limit or value < -limit:
        raise ValidationError("Exponent outside the supported range of +/- 20", value=value)

    precise = value * 1000

    # k chosen so that the remainder lands in [-ln2/2, ln2/2].
    if precise >= 0:
        k = (precise + _HALF_LN2_PRECISE) // _LN2_PRECISE
    else:
        k = -((-precise + _HALF_LN2_PRECISE) // _LN2_PRECISE)
    remainder = precise - k * _LN2_PRECISE

    total = _PRECISE
    term = _PRECISE
    for n in range(1, 25):
        term = _round_div(term * remainder, _PRECISE) // n
        if term == 0:
            break
        total += term

    # Multiplying by 2^k rather than shifting the result: a shift on the way
    # down throws away the bits that carry the answer.
    scaled = total << k if k >= 0 else _round_div(total, 1 << (-k))
    return _round_div(scaled, 1000)
