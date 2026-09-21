"""Every name this package advertises can actually be imported.

For 1.0.0 ``rankmode.engine.__all__`` carried ``create_member_state`` and the
module never imported it, so the very line the comment above it described --
``from rankmode.engine import create_member_state`` -- raised ``ImportError``,
and ``import *`` raised ``AttributeError``. 473 tests did not notice, because no
test imports from a submodule and no test exercises a star import.

These do.
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest

import rankmode

#: Every module in the package, found rather than listed - a new module is
#: covered the moment it exists.
MODULES = sorted(
    info.name for info in pkgutil.iter_modules(rankmode.__path__, f"{rankmode.__name__}.")
)


def test_the_package_has_modules() -> None:
    # If the discovery above ever breaks, every test below would pass vacuously.
    assert len(MODULES) >= 8, MODULES


@pytest.mark.parametrize("module_name", MODULES + ["rankmode"])
def test_every_name_in_all_exists(module_name: str) -> None:
    module = importlib.import_module(module_name)
    exported = getattr(module, "__all__", None)
    if exported is None:
        return

    missing = [name for name in exported if not hasattr(module, name)]
    assert not missing, f"{module_name}.__all__ advertises {missing}, which do not exist"


@pytest.mark.parametrize("module_name", MODULES + ["rankmode"])
def test_star_import_works(module_name: str) -> None:
    namespace: dict[str, object] = {}
    exec(f"from {module_name} import *", namespace)  # noqa: S102 - the point of the test

    module = importlib.import_module(module_name)
    for name in getattr(module, "__all__", []):
        assert name in namespace, f"`from {module_name} import *` did not bind {name}"


def test_the_package_exports_what_the_readme_promises() -> None:
    # The names the README's five-minute example uses. A rename that misses one
    # of these breaks the first thing anybody runs.
    for name in (
        "RankEngine",
        "create_event_rule",
        "create_member_state",
        "build_leaderboard",
        "preview_migration",
        "QuadraticCurve",
        "AwardOutcome",
        "SystemRandomSource",
    ):
        assert hasattr(rankmode, name), name
        assert name in rankmode.__all__, f"{name} is importable but not in __all__"


def test_engine_re_exports_create_member_state() -> None:
    # The exact import the comment in engine.py describes, and the exact one
    # that raised ImportError in 1.0.0.
    from rankmode.engine import create_member_state

    assert create_member_state(5).total_xp == 5


def test_the_version_is_a_release_version() -> None:
    parts = rankmode.__version__.split(".")
    assert len(parts) == 3, rankmode.__version__
    assert all(part.isdigit() for part in parts), rankmode.__version__
