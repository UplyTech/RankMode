"""The three random sources."""

from __future__ import annotations

import pytest

from rankmode import (
    FixedRandomSource,
    RandomSource,
    SeededRandomSource,
    SystemRandomSource,
    ValidationError,
)


class TestSystemRandomSource:
    source = SystemRandomSource()

    def test_stays_inside_the_requested_span(self) -> None:
        for _ in range(500):
            value = self.source.random_int(15, 25)
            assert 15 <= value <= 25
            assert isinstance(value, int)

    def test_includes_both_ends_of_the_span(self) -> None:
        seen = {self.source.random_int(0, 2) for _ in range(2000)}
        assert seen == {0, 1, 2}

    def test_returns_the_value_itself_for_a_span_of_one(self) -> None:
        assert self.source.random_int(7, 7) == 7

    @pytest.mark.parametrize(("low", "high"), [(10, 5), (1.5, 5), (1, "5")])
    def test_rejects_an_impossible_span(self, low: object, high: object) -> None:
        with pytest.raises(ValidationError):
            self.source.random_int(low, high)  # type: ignore[arg-type]

    def test_satisfies_the_protocol(self) -> None:
        assert isinstance(self.source, RandomSource)
        assert isinstance(SeededRandomSource(1), RandomSource)
        assert isinstance(FixedRandomSource([1]), RandomSource)


class TestSeededRandomSource:
    def test_same_seed_same_sequence(self) -> None:
        a = SeededRandomSource(42)
        b = SeededRandomSource(42)
        assert [a.random_int(0, 1000) for _ in range(50)] == [
            b.random_int(0, 1000) for _ in range(50)
        ]

    def test_different_seeds_differ(self) -> None:
        a = SeededRandomSource(1)
        b = SeededRandomSource(2)
        assert [a.random_int(0, 1_000_000) for _ in range(20)] != [
            b.random_int(0, 1_000_000) for _ in range(20)
        ]

    def test_stays_inside_the_span(self) -> None:
        source = SeededRandomSource(99)
        assert all(15 <= source.random_int(15, 25) <= 25 for _ in range(1000))

    def test_raw_output_is_a_32_bit_value(self) -> None:
        source = SeededRandomSource(0)
        for _ in range(100):
            value = source.next_32()
            assert 0 <= value <= 0xFFFFFFFF

    def test_returns_the_value_itself_for_a_span_of_one(self) -> None:
        assert SeededRandomSource(5).random_int(7, 7) == 7

    @pytest.mark.parametrize("seed", [1.5, "42", None])
    def test_refuses_a_non_integer_seed(self, seed: object) -> None:
        with pytest.raises(ValidationError):
            SeededRandomSource(seed)  # type: ignore[arg-type]


class TestFixedRandomSource:
    def test_replays_its_values_in_order(self) -> None:
        source = FixedRandomSource([1, 2, 3])
        assert [source.random_int(0, 10) for _ in range(3)] == [1, 2, 3]
        assert source.consumed == 3

    def test_cycles_by_default(self) -> None:
        source = FixedRandomSource([1, 2])
        assert [source.random_int(0, 10) for _ in range(3)] == [1, 2, 1]

    def test_can_refuse_to_cycle(self) -> None:
        source = FixedRandomSource([1], cycle=False)
        source.random_int(0, 10)
        with pytest.raises(ValidationError):
            source.random_int(0, 10)

    def test_clamps_a_value_the_rule_would_not_allow(self) -> None:
        source = FixedRandomSource([0, 999])
        assert source.random_int(15, 25) == 15
        assert source.random_int(15, 25) == 25

    def test_can_be_rewound(self) -> None:
        source = FixedRandomSource([5, 6])
        source.random_int(0, 10)
        source.reset()
        assert source.random_int(0, 10) == 5

    def test_needs_at_least_one_value(self) -> None:
        with pytest.raises(ValidationError):
            FixedRandomSource([])
