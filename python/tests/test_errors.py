"""The error hierarchy."""

from __future__ import annotations

import pytest

from rankmode import (
    ConfigurationError,
    CurveError,
    MigrationError,
    RankModeError,
    ValidationError,
    XpOverflowError,
)

CASES = [
    (ConfigurationError, "CONFIGURATION_ERROR"),
    (ValidationError, "VALIDATION_ERROR"),
    (CurveError, "CURVE_ERROR"),
    (XpOverflowError, "XP_OVERFLOW"),
    (MigrationError, "MIGRATION_ERROR"),
]


@pytest.mark.parametrize(("cls", "code"), CASES)
def test_one_base_class_catches_everything(cls: type, code: str) -> None:
    with pytest.raises(RankModeError):
        raise cls("boom")


@pytest.mark.parametrize(("cls", "code"), CASES)
def test_carries_a_stable_code(cls: type, code: str) -> None:
    assert cls("boom").code == code


def test_the_base_class_has_its_own_code() -> None:
    assert RankModeError("boom").code == "RANKMODE_ERROR"


def test_carries_structured_details() -> None:
    error = ValidationError("bad total", total_xp=-5)
    assert error.details["total_xp"] == -5
    assert error.message == "bad total"


def test_details_are_read_only() -> None:
    error = ValidationError("bad total", total_xp=-5)
    with pytest.raises(TypeError):
        error.details["total_xp"] = 0  # type: ignore[index]


def test_details_default_to_empty() -> None:
    assert dict(RankModeError("x").details) == {}


def test_is_a_plain_exception() -> None:
    assert isinstance(ValidationError("x"), Exception)
    assert str(ValidationError("x")) == "x"
