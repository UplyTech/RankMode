# Differential harness

`shared/testcases/` is a fixed list. This is not.

## Why it exists

The shared vectors are the contract between the two editions, and they work.
They caught nothing in 1.x, because of what they are: a list of cases somebody
sat down and wrote. Three separate divergences lived in the TypeScript edition
for the whole of 1.x, and none of them was findable that way:

| Divergence | Appears when |
|---|---|
| `ExponentialCurve` built a different threshold table | `cost * growthPermille` passes 2⁵³ |
| `applyMultipliers` returned a different amount | the running value passes 2⁵³ |
| `progressForTotalXp` reported a different bar | a level is wider than about 9 × 10¹² |

Every vector probed totals up to 1,000,000 and curve bases up to 100. Every unit
test in both suites worked in the same range. The bugs were in the arithmetic
*above* that range — and specifically in the intermediate product, while the
inputs and the answers stayed comfortably inside it, so there was no oversized
value anywhere for a guard to notice.

A fixed list catches a regression in something somebody already imagined. This
catches the rest. It has since done it again: on its first serious run over the
ranked system added in 3.0.0 it found that a rating below the lowest tier
threshold produced an impossible ladder position — Python raised `ValueError`
and TypeScript returned a position carrying a division that does not exist.
Neither edition's own test suite had a case for a negative rating, because
nobody had thought to write one.

## Running it

```bash
cd typescript && npm run build && cd ..
bash shared/tools/differential/parity.sh          # seed 1, 5000 cases
bash shared/tools/differential/parity.sh 7 50000  # a specific seed and size
```

Nothing in the repository is written; everything lands in a scratch directory.
`PYTHON=...` picks the interpreter, `PARITY_WORK_DIR=...` the scratch directory.

## The parts

| File | Does |
|---|---|
| `generate.mjs` | Writes the questions. Computes nothing itself. |
| `run-typescript.mjs` | Answers them with the **built** TypeScript package. |
| `run_python.py` | Answers them with the Python edition. |
| `compare.py` | Decides whether the answers agree, and prints the smallest case that reproduces a disagreement. |
| `parity.sh` | All four, in order. |

Two things about that split are deliberate:

**The runners mirror each other line for line.** A difference between them is a
difference in the *harness*, not in the library, and that is the one kind of
false positive that would make nobody trust the red build.

**The comparison runs in Python.** Python parses a JSON integer exactly at any
size; `JSON.parse` in Node does not. A comparison that silently rounded both
sides before comparing them would report agreement about precisely the thing
this harness exists to disagree about.

## What it generates

Ten kinds of case, six for the participation half and four for the ranked one:

| Kind | Covers |
|---|---|
| `curve` | Threshold tables, level lookups, progress. |
| `multipliers` | Permille chains, where the running value grows with every factor. |
| `award` | Whole award sequences: cooldowns, caps, penalties, decay, pruning. |
| `leaderboard` | Ranking and every tie mode. |
| `migration` | Curve changes under every strategy. |
| `state` | The state a caller stores and loads back. |
| `rating` | Expected scores, Elo, Glicko-2 single updates and whole periods, rating intervals. |
| `ladder` | Bracket seeding, League Points, promotion series, demotion, season resets. |
| `ranked` | A whole season through the engine, up to forty matches, carrying state forward. |
| `matchmaking` | Match quality both ways round, team ratings, team balancing. |

Magnitudes are drawn from a distribution that spends most of its time where bugs
are rather than where numbers are:

- everyday values, and values across a real community's range
- values anywhere in the safe range
- **values within a few thousand of 2⁵³ − 1**, which is the last band and the
  interesting one
- one either side of every threshold, cap, ceiling and level boundary
- **rating gaps wide enough that Glicko-2's estimated variance blows up.** At a
  difference of about 2000 points the expected score rounds to a handful of
  micro-units, the variance is its reciprocal, and `delta²` reaches 10¹⁸ — past
  the last integer a double represents exactly. A uniform draw over the rating
  range would hardly ever visit that band.
- deviations and volatilities at both ends of their ranges, where the volatility
  solver's bracket is degenerate

The `ranked` kind is the one that carries state forward, and therefore the only
one that can find a divergence which needs a hundred updates before it is a
whole rating point. The `matchmaking` kind deliberately asks each pairing both
ways round: quality being independent of argument order is a property that used
to fail, and a harness that only asked one way would not have seen it.

An error is an answer too. Both editions must agree about what they *refuse* as
well as about what they compute, so a raised error is compared by class name —
which is how a validation asymmetry between the editions shows up here rather
than in somebody's bot.

## Reading a failure

```text
::error::the editions disagree on 6 of 2000 cases

--- c61  (multipliers) ----------------------------------------
  .value.applied
      python     270215977642190250
      typescript 270215977642190240

  the case, for shared/testcases/:
  { "id": "c61", "kind": "multipliers", "baseXp": 9007199254739675, ... }
```

The path names the exact field. Python's answer is on top because Python's
integers are exact, so its answer is the definition of correct wherever the two
differ by rounding.

The printed case is meant to be moved: add it to `shared/testcases/` so the
specific failure is pinned forever, then fix the cause. That is what happened to
all three divergences above, and it is where every fixed bug in this library
ends up.

## In CI

| Workflow | Runs |
|---|---|
| `ci.yml` → `parity` | Seed 1, 20,000 cases, on every push and pull request. Deterministic, so a red build is one command to reproduce. |
| `security.yml` → `parity-fuzz` | A **random** seed, 200,000 cases, nightly. This is the one that goes looking; the seed is printed so a failure is reproducible. |

## Adding a case kind

1. A generator function in `generate.mjs`, added to `KINDS`.
2. A branch in `answer()` in **both** runners, emitting the same keys in the
   same order.
3. Nothing in `compare.py` — it walks whatever shape it is given.

Keep the two runners readable side by side. That is worth more than either of
them being idiomatic on its own.
