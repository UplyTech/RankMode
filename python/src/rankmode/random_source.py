"""Where the random span in an award comes from.

Awarding a fixed number of XP per message invites members to work out the
exact rate and farm it. A span makes that pointless. A *built-in* random
generator, however, would make the whole library untestable -- so the source is
handed in: the real one in production, a predictable one in tests.

In production use :class:`SystemRandomSource`. A predictable generator lets a
member who knows the algorithm predict the next award, which is exactly the
farming the span was meant to prevent.
"""

from __future__ import annotations

import secrets
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from .errors import ValidationError

__all__ = [
    "RandomSource",
    "SystemRandomSource",
    "SeededRandomSource",
    "FixedRandomSource",
]

_UINT32 = 0xFFFFFFFF


@runtime_checkable
class RandomSource(Protocol):
    """Anything that can produce an integer inside an inclusive span."""

    def random_int(self, minimum: int, maximum: int) -> int:
        """Uniformly distributed integer in ``[minimum, maximum]``."""
        ...  # pragma: no cover - protocol definition


class SystemRandomSource:
    """Cryptographically sound source, backed by :mod:`secrets`.

    The production default. Uses rejection-free ``randbelow``, which draws
    uniformly and does not favour the lower end of the span the way a plain
    modulo of a fixed-width value would.
    """

    def random_int(self, minimum: int, maximum: int) -> int:
        _assert_range(minimum, maximum)
        if minimum == maximum:
            return minimum
        return minimum + secrets.randbelow(maximum - minimum + 1)


class SeededRandomSource:
    """Deterministic source for tests and for reproducing a reported result.

    The algorithm is mulberry32, chosen because it is short enough to be
    reimplemented identically in every edition of this library -- the shared
    vector file ``random.json`` proves that both editions do. It is *not*
    suitable for production: see the module docstring.
    """

    def __init__(self, seed: int) -> None:
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise ValidationError("Seed must be an integer", seed=seed)
        self._state = seed & _UINT32

    def next_32(self) -> int:
        """Next raw 32-bit value. Exposed so the editions can be compared."""
        self._state = (self._state + 0x6D2B79F5) & _UINT32
        t = self._state
        t = (_imul(t ^ (t >> 15), t | 1)) & _UINT32
        t = (t ^ (t + _imul(t ^ (t >> 7), t | 61))) & _UINT32
        return (t ^ (t >> 14)) & _UINT32

    def random_int(self, minimum: int, maximum: int) -> int:
        _assert_range(minimum, maximum)
        if minimum == maximum:
            return minimum
        span = maximum - minimum + 1
        return minimum + (self.next_32() % span)


class FixedRandomSource:
    """Replays a fixed list of values.

    This is what the shared test vectors use: it needs no agreement about a
    pseudo-random algorithm between the editions, only about the values.
    Out-of-range values are clamped into ``[minimum, maximum]`` so a vector
    cannot accidentally produce an award the rule does not allow.
    """

    def __init__(self, values: Sequence[int], cycle: bool = True) -> None:
        if not values:
            raise ValidationError("FixedRandomSource needs at least one value")
        self._values = tuple(values)
        self._index = 0
        self._cycle = cycle

    def random_int(self, minimum: int, maximum: int) -> int:
        _assert_range(minimum, maximum)
        if self._index >= len(self._values):
            if not self._cycle:
                raise ValidationError(
                    "FixedRandomSource ran out of values", consumed=self._index
                )
            self._index = 0
        value = self._values[self._index]
        self._index += 1
        if value < minimum:
            return minimum
        if value > maximum:
            return maximum
        return value

    @property
    def consumed(self) -> int:
        """How many values have been consumed so far."""
        return self._index

    def reset(self) -> None:
        """Start again from the first value."""
        self._index = 0


def _imul(a: int, b: int) -> int:
    """The low 32 bits of a 32-bit multiplication.

    Mirrors JavaScript's ``Math.imul``. Two's-complement multiplication agrees
    with unsigned multiplication in the low 32 bits, so masking is enough --
    no sign juggling is needed.
    """
    return (a * b) & _UINT32


def _assert_range(minimum: int, maximum: int) -> None:
    if (
        not isinstance(minimum, int)
        or not isinstance(maximum, int)
        or isinstance(minimum, bool)
        or isinstance(maximum, bool)
    ):
        raise ValidationError(
            "Random bounds must be integers", minimum=minimum, maximum=maximum
        )
    if maximum < minimum:
        raise ValidationError(
            "Upper random bound is below the lower one",
            minimum=minimum,
            maximum=maximum,
        )
