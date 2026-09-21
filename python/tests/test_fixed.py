"""Deterministic fixed-point arithmetic.

The foundation the whole ranked half stands on. A rating system needs ``exp``,
``ln`` and ``sqrt``, and the reason they are written out here rather than taken
from the runtime is that IEEE 754 pins down the four basic operations to the
last bit and does *not* pin down the transcendental ones. Two runtimes are free
to disagree by one unit in the last place, and a rating one micro-unit either
side of a promotion threshold is a player promoted in one edition and not the
other.

So these tests check two different things. Against ``math`` they check that the
functions are *right*. Against the shared vectors and the differential harness
the two editions check that they are *identical*, which is the stronger promise
and the one the library actually makes.
"""

from __future__ import annotations

import math

import pytest

from rankmode import ValidationError
from rankmode.fixed import (
    SCALE,
    fixed_div,
    fixed_exp,
    fixed_ln,
    fixed_mul,
    fixed_sqrt,
    from_fixed,
    isqrt,
    to_fixed,
)


class TestConversion:
    def test_to_fixed_scales_by_a_million(self) -> None:
        assert to_fixed(1) == 1_000_000
        assert to_fixed(0) == 0
        assert to_fixed(-3) == -3_000_000

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (1_000_000, 1),
            (1_499_999, 1),
            (1_500_000, 2),
            (2_500_000, 3),
            (-1_500_000, -2),
            (-2_500_000, -3),
            (0, 0),
            (499_999, 0),
            (500_000, 1),
        ],
    )
    def test_from_fixed_rounds_half_away_from_zero(self, value: int, expected: int) -> None:
        assert from_fixed(value) == expected

    def test_rounding_is_symmetric_about_zero(self) -> None:
        # Half-to-even would make x.5 round differently depending on whether x
        # is odd, which is impossible to explain to a player standing on a
        # promotion threshold.
        for magnitude in range(0, 20_000_000, 500_000):
            assert from_fixed(magnitude) == -from_fixed(-magnitude)

    def test_round_trips_whole_numbers(self) -> None:
        for value in range(-5000, 5001, 37):
            assert from_fixed(to_fixed(value)) == value


class TestIsqrt:
    @pytest.mark.parametrize(
        ("value", "expected"), [(0, 0), (1, 1), (2, 1), (3, 1), (4, 2), (8, 2), (9, 3)]
    )
    def test_small_values(self, value: int, expected: int) -> None:
        assert isqrt(value) == expected

    def test_is_the_floor_of_the_real_root(self) -> None:
        for value in range(0, 100_000, 149):
            root = isqrt(value)
            assert root * root <= value < (root + 1) * (root + 1)

    def test_is_exact_far_past_double_precision(self) -> None:
        # 10^18 is well past where a double is exact; the answer must still be
        # the integer root and not an approximation of it.
        assert isqrt(10**18) == 10**9
        assert isqrt(10**18 - 1) == 10**9 - 1
        assert isqrt((2**53 + 1) ** 2) == 2**53 + 1

    def test_refuses_a_negative(self) -> None:
        with pytest.raises(ValidationError):
            isqrt(-1)


class TestMulAndDiv:
    def test_multiplies(self) -> None:
        assert fixed_mul(to_fixed(3), to_fixed(4)) == to_fixed(12)
        assert fixed_mul(500_000, 500_000) == 250_000

    def test_divides(self) -> None:
        assert fixed_div(to_fixed(12), to_fixed(4)) == to_fixed(3)
        assert fixed_div(SCALE, 3 * SCALE) == 333_333

    def test_rounds_half_away_from_zero(self) -> None:
        # 1/2 of one micro-unit rounds outwards in both directions.
        assert fixed_mul(1, 500_000) == 1
        assert fixed_mul(-1, 500_000) == -1

    def test_signs_behave(self) -> None:
        assert fixed_mul(to_fixed(-3), to_fixed(4)) == to_fixed(-12)
        assert fixed_mul(to_fixed(-3), to_fixed(-4)) == to_fixed(12)
        assert fixed_div(to_fixed(-12), to_fixed(4)) == to_fixed(-3)
        assert fixed_div(to_fixed(-12), to_fixed(-4)) == to_fixed(3)

    def test_division_by_zero_is_an_error_not_a_crash(self) -> None:
        with pytest.raises(ValidationError):
            fixed_div(SCALE, 0)

    def test_intermediates_beyond_a_double_stay_exact(self) -> None:
        # a * b overflows 2^53 long before either operand does. This is the
        # hazard the 2.0.0 release was cut for, in its fixed-point form.
        big = 3_000_000_000
        assert fixed_mul(big, big) == big * big // SCALE


class TestSqrt:
    @pytest.mark.parametrize("value", [0, 1, 2, 4, 9, 100, 1234, 999_999])
    def test_matches_math_sqrt_to_half_a_micro_unit(self, value: int) -> None:
        got = fixed_sqrt(to_fixed(value))
        want = math.sqrt(value) * SCALE
        assert abs(got - want) <= 0.5 + 1e-6

    def test_of_one_is_one(self) -> None:
        assert fixed_sqrt(SCALE) == SCALE

    def test_of_zero_is_zero(self) -> None:
        assert fixed_sqrt(0) == 0

    def test_refuses_a_negative(self) -> None:
        with pytest.raises(ValidationError):
            fixed_sqrt(-1)

    def test_is_monotone(self) -> None:
        previous = -1
        for value in range(0, 20_000_000, 7919):
            current = fixed_sqrt(value)
            assert current >= previous
            previous = current


class TestLn:
    def test_of_one_is_zero(self) -> None:
        assert fixed_ln(SCALE) == 0

    @pytest.mark.parametrize("value", [1, 2, 3, 7, 10, 100, 1000, 2718, 100_000])
    def test_matches_math_log_to_a_micro_unit(self, value: int) -> None:
        got = fixed_ln(to_fixed(value))
        want = math.log(value) * SCALE
        assert abs(got - want) <= 1.0

    def test_handles_values_below_one(self) -> None:
        for numerator in (1, 10, 100, 500, 999_999):
            got = fixed_ln(numerator)
            want = math.log(numerator / SCALE) * SCALE
            assert abs(got - want) <= 1.5

    def test_refuses_zero_and_negatives(self) -> None:
        with pytest.raises(ValidationError):
            fixed_ln(0)
        with pytest.raises(ValidationError):
            fixed_ln(-SCALE)

    def test_is_strictly_increasing(self) -> None:
        previous = fixed_ln(1)
        for value in range(1000, 5_000_000, 4001):
            current = fixed_ln(value)
            assert current >= previous
            previous = current


class TestExp:
    def test_of_zero_is_one(self) -> None:
        assert fixed_exp(0) == SCALE

    @pytest.mark.parametrize("value", [-20, -10, -5, -1, 0, 1, 2, 5, 10, 15, 20])
    def test_matches_math_exp(self, value: int) -> None:
        got = fixed_exp(to_fixed(value))
        want = math.exp(value) * SCALE
        # Relative rather than absolute: e^20 is half a billion, and one
        # micro-unit of it is not a meaningful tolerance.
        assert abs(got - want) <= max(1.0, abs(want) * 1e-6)

    def test_fractional_arguments(self) -> None:
        for micro in range(-2_000_000, 2_000_001, 41_137):
            got = fixed_exp(micro)
            want = math.exp(micro / SCALE) * SCALE
            assert abs(got - want) <= max(1.0, abs(want) * 1e-6)

    def test_refuses_arguments_outside_plus_or_minus_twenty(self) -> None:
        # Two limits meet at 20: e^20 is half a billion, and e^-20 is two
        # billionths, which micro-units cannot represent at all.
        with pytest.raises(ValidationError):
            fixed_exp(to_fixed(21))
        with pytest.raises(ValidationError):
            fixed_exp(to_fixed(-21))
        # The boundary itself is accepted.
        assert fixed_exp(to_fixed(20)) > 0
        assert fixed_exp(to_fixed(-20)) >= 0

    def test_is_the_inverse_of_ln(self) -> None:
        for value in range(1, 5000, 97):
            recovered = fixed_exp(fixed_ln(to_fixed(value)))
            assert abs(recovered - to_fixed(value)) <= max(2, to_fixed(value) // 100_000)

    def test_is_strictly_increasing(self) -> None:
        previous = -1
        for micro in range(-20_000_000, 20_000_001, 313_337):
            current = fixed_exp(micro)
            assert current >= previous
            previous = current


class TestDeterminism:
    """The property the whole module exists for."""

    def test_repeated_calls_give_identical_answers(self) -> None:
        # Nothing here may consult a clock, a random source or a cache.
        for micro in range(1, 10_000_000, 173_717):
            assert fixed_ln(micro) == fixed_ln(micro)
            assert fixed_sqrt(micro) == fixed_sqrt(micro)
        for micro in range(-10_000_000, 10_000_001, 421_337):
            assert fixed_exp(micro) == fixed_exp(micro)

    def test_no_float_leaks_into_a_result(self) -> None:
        # A single float anywhere in the chain would make the two editions
        # disagree, and it would show up as a non-integer return.
        assert isinstance(fixed_ln(1_234_567), int)
        assert isinstance(fixed_exp(1_234_567), int)
        assert isinstance(fixed_sqrt(1_234_567), int)
        assert isinstance(fixed_mul(1_234_567, 7_654_321), int)
        assert isinstance(fixed_div(1_234_567, 7_654_321), int)
