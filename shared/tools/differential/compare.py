#!/usr/bin/env python3
"""Decide whether the two editions agreed.

    python compare.py --cases cases.json \
        --python results-python.json --typescript results-typescript.json

The comparison runs in Python and not in Node on purpose. Python parses a JSON
integer exactly at any size; ``JSON.parse`` in Node does not, and a comparison
that silently rounds both sides before comparing them would report agreement
about the one thing this whole harness exists to disagree about.

A disagreement is printed as the smallest case that reproduces it, in a form
that can be pasted into ``shared/testcases/`` - because that is where every
fixed bug in this library ends up.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent

#: How many disagreements to print in full before summarising the rest. A run
#: that finds four hundred of them is one bug, and the first one is the one
#: somebody will fix.
MAX_REPORTED = 5


def differences(left: Any, right: Any, path: str = "") -> list[tuple[str, Any, Any]]:
    """Every leaf where the two answers differ, with the path to it."""
    if isinstance(left, dict) and isinstance(right, dict):
        found: list[tuple[str, Any, Any]] = []
        for key in sorted(set(left) | set(right)):
            if key not in left:
                found.append((f"{path}.{key}", "<missing>", right[key]))
            elif key not in right:
                found.append((f"{path}.{key}", left[key], "<missing>"))
            else:
                found.extend(differences(left[key], right[key], f"{path}.{key}"))
        return found

    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return [(f"{path}.length", len(left), len(right))]
        found = []
        for index, (a, b) in enumerate(zip(left, right)):
            found.extend(differences(a, b, f"{path}[{index}]"))
        return found

    # `True == 1` in Python, and the two editions must not be allowed to agree
    # through that, so booleans are compared as booleans and never as numbers.
    if isinstance(left, bool) or isinstance(right, bool):
        if type(left) is not type(right) or left != right:
            return [(path or ".", left, right)]
        return []

    # Integers and floats are compared by value. `progress_ratio` is a float in
    # both editions, and Python writes 1.0 where JSON.stringify writes 1 - the
    # same number, spelled differently. An integer that actually differs still
    # differs: Python's integers are exact, so a value the TypeScript edition
    # rounded reaches here as a different number, not as a different spelling.
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        if left != right:
            return [(path or ".", left, right)]
        return []

    if type(left) is not type(right) or left != right:
        return [(path or ".", left, right)]

    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default=str(HERE / "cases.json"))
    parser.add_argument("--python", default=str(HERE / "results-python.json"))
    parser.add_argument("--typescript", default=str(HERE / "results-typescript.json"))
    args = parser.parse_args()

    cases = {item["id"]: item for item in json.loads(Path(args.cases).read_text("utf-8"))["cases"]}
    py = json.loads(Path(args.python).read_text("utf-8"))
    ts = json.loads(Path(args.typescript).read_text("utf-8"))

    if py["seed"] != ts["seed"]:
        print(f"::error::the two runs used different seeds: {py['seed']} and {ts['seed']}")
        return 2

    py_results = {item["id"]: item for item in py["results"]}
    ts_results = {item["id"]: item for item in ts["results"]}

    if set(py_results) != set(ts_results):
        print("::error::the two runs answered different sets of cases")
        return 2

    disagreements = []
    for case_id in sorted(py_results, key=lambda name: int(name.lstrip("c"))):
        found = differences(py_results[case_id], ts_results[case_id])
        if found:
            disagreements.append((case_id, found))

    total = len(py_results)
    if not disagreements:
        print(f"ok - both editions agree on all {total} cases (seed {py['seed']})")
        return 0

    print(f"::error::the editions disagree on {len(disagreements)} of {total} cases")
    print()

    by_kind: dict[str, int] = {}
    for case_id, _ in disagreements:
        kind = cases[case_id]["kind"]
        by_kind[kind] = by_kind.get(kind, 0) + 1

    for case_id, found in disagreements[:MAX_REPORTED]:
        case = cases[case_id]
        print(f"--- {case_id}  ({case['kind']}) " + "-" * 40)
        for path, left, right in found[:8]:
            print(f"  {path}")
            print(f"      python     {left!r}")
            print(f"      typescript {right!r}")
        if len(found) > 8:
            print(f"  ... and {len(found) - 8} more leaves in this case")
        print()
        print("  the case, for shared/testcases/:")
        print("  " + json.dumps(case, indent=2).replace("\n", "\n  "))
        print()

    if len(disagreements) > MAX_REPORTED:
        print(f"... and {len(disagreements) - MAX_REPORTED} further disagreeing cases")
        print()

    print("by kind:")
    for kind, count in sorted(by_kind.items(), key=lambda pair: -pair[1]):
        print(f"  {count:6d}  {kind}")
    print()
    print(f"reproduce with: node generate.mjs --seed {py['seed']} --cases {total}")

    return 1


if __name__ == "__main__":
    sys.exit(main())
