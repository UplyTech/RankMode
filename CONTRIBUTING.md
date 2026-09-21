# Contributing to RankMode

Thank you for looking. This library is small on purpose, and most of the rules
below exist to keep it that way.

## The one rule that matters most

> **A change to what a curve computes is a major version, always.**

A curve change moves the level of every member in every community that uses the
library. Somebody who went to bed at level 12 wakes up at level 9 and opens a
support ticket. That is not a bug to be fixed later; it is a release decision to
be made deliberately, announced in advance, and shipped with a migration.

If your change alters a single number in a threshold table, it is major. No
exceptions, no matter how obviously the old number was wrong.

## Change classification

| Change | Version bump |
|---|---|
| Bug fix with no behaviour change | patch |
| Security fix | patch, back-ported to the previous major |
| New curve shape | minor |
| New rule option, new outcome, new helper | minor |
| **Any change to what an existing curve computes** | **major** |
| **Any change to what a rating or ladder formula computes** | **major** — it moves every player's rank |
| Removing or renaming anything public | major, deprecated one minor beforehand |

## Both editions, or neither

RankMode ships a Python and a TypeScript edition that must behave identically.
A pull request that changes behaviour in one and not the other will not be
merged, even if both suites are green — the shared vectors would simply not be
covering the thing you changed yet.

The working order:

1. Change the behaviour in **both** `python/src/rankmode/` and `typescript/src/`.
2. Add a case to the relevant file under `shared/testcases/` — see below.
3. Run both suites.
4. Run the differential harness (below). It generates cases you did not think
   of, which is the point: in 1.x three divergences survived 473 tests and a
   full set of vectors, because every one of them worked below 10⁶ and every
   divergence appeared only above 2⁵³.

> **A note on arithmetic.** Python integers are exact at any size; a JavaScript
> `number` is not, above 2⁵³ − 1. Any expression of the shape
> `Math.floor(a * b / c)` in the TypeScript edition is a bug waiting to happen,
> because the *intermediate product* can leave the safe range while the inputs
> and the answer both stay inside it — so there is no oversized value for a
> guard to catch. Use `mulDivFloor` from `src/exact.ts`.

## Changing the shared test vectors

The vectors in `shared/testcases/` are the contract between the editions. They
are generated from the TypeScript edition:

```bash
cd typescript
npm run build
node scripts/generate-shared-vectors.mjs
```

**Regenerating is a deliberate act.** If a vector file changes, the behaviour of
the library changed, and that belongs in `CHANGELOG.md` with the matching
version bump.

> Never regenerate the vectors to make a failing test pass. A failing vector is
> the system working: it is telling you the two editions have drifted apart, or
> that you changed something you did not mean to change. Find out which before
> you touch the JSON.

Review the `git diff` of the vector files as carefully as you review code. A
one-line diff in `curves.json` is a major version, and so is one in
`ranked.json`.

`ranked.json` deserves a note of its own. Most of it is one call with one
answer, and a diff there is easy to read. The `engine` section is four whole
seasons replayed match by match, so a change deep in the rating maths shows up
as hundreds of changed lines — which is the point. If you find yourself
scrolling past a diff like that, stop: it means the change moves every ranked
player, and the changelog has to say so in a sentence an operator can act on.

## Running everything

```bash
# Python
cd python
python -m venv .venv
.venv/bin/pip install -e ".[dev]"          # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest --cov=rankmode  # coverage gate: 95 %
.venv/bin/python -m mypy                   # strict
.venv/bin/python -m ruff check src tests examples
.venv/bin/python -m ruff format --check src tests examples

# TypeScript
cd typescript
npm install
npm test
npm run test:coverage                      # coverage gate: 95 %
npm run typecheck
npm run lint
npm run build
```

Both editions must also still agree on cases nobody wrote down:

```bash
cd typescript && npm run build && cd ..
bash shared/tools/differential/parity.sh 1 20000
```

That is the same command CI runs. A failure prints the smallest case that
reproduces it, in a form that pastes straight into `shared/testcases/` — which
is where every fixed bug in this library ends up.

Both examples should also still run:

```bash
cd python      && PYTHONPATH=src .venv/bin/python examples/basic.py
cd typescript  && npx vite-node examples/basic.ts
```

They print the same numbers on purpose. If they stop doing so, something drifted.

## What belongs in this library

Before adding a feature, check it against the boundaries. These are not
negotiable defaults — they are the reason the library works for a Discord bot, a
forum and a website at the same time:

- **No storage.** Not a cache, not an optional repository interface, not "just a
  small dict". The caller owns the state.
- **No platform knowledge.** No Discord, no HTTP, no message, no role, no
  channel. If a type name would contain the word "guild", it does not go here.
- **No display.** No image generation, no string formatting of level cards, no
  embed builders.
- **No reward logic.** RankMode reports that a level was reached. Deciding what
  that earns and handing it out is the caller's job.
- **No currency, and nothing economic on top of one.** Points are recognition;
  balances are purchasing power. Balances, shops, banking, credit and markets
  are all [EconomyWorld](../EconomyWorld), and the two libraries are kept apart
  on purpose.
- **No ambient input.** Nothing read from the system clock, the environment or a
  global random generator. Time and randomness are parameters. A season boundary
  is a timestamp the caller passes in, for the same reason.
- **No queue.** RankMode says how good a pairing is and how to split a group
  into two teams. Holding the pool of waiting players, deciding when to widen
  the search and talking to a lobby belong to the caller, who already has the
  players in memory.
- **No floating point in anything a caller can see.** A probability is a
  permille integer, a rating is a whole point, and the transcendental functions
  the rating maths needs are computed on integers in `fixed`. Two runtimes are
  free to disagree about `exp` in the last place, and this library is not.
- **No logging.** Not even of member ids. The library sees identifiers in a call
  and forgets them.

## Code style

- **Integers only** in anything that affects a result. Multipliers and progress
  are permille integers, never floats. Floating point in a level formula
  produces differences between the editions, and nobody expects them.
- **New public behaviour needs a shared vector.** A feature that only one edition
  is tested for is a feature that will drift.
- **Comments explain decisions, not mechanics.** `# floor division` is noise;
  `# Floor, so a member is never pushed into the next level by the migration`
  is the reason somebody will need in two years.
- Python: `ruff check`, **`ruff format --check`** and `mypy --strict` must be
  clean. TypeScript: `eslint` and `tsc --noEmit` must be clean, over the source
  *and* the tests *and* the examples.
- **The formatter decides layout, not review.** `ruff format` was adopted in
  2.0.0 so that no pull request ever spends a comment on where a line breaks —
  and because two editions whose diffs have to be read side by side are worth
  keeping regular. Run `ruff format src tests examples` before pushing.

## Coverage

The gate is 95 % in both editions — higher than the general UplyTech package
standard of 90 %, because a wrong formula here is wrong in every calling bot at
once.

Coverage is a floor, not a goal. A test that pins down *why* a number is what it
is beats three that walk the same happy path.

For anything in the ranked half, a property belongs in
`test_ranked_properties.py` / `ranked-properties.test.ts` as well. Three of the
defects that release fixed were failures of a stated property and of no example:
the volatility solver's two-cycle, the deviation decay's fixed point, and a match
quality that depended on argument order. None of them is visible in a single
case, and all three fail a property in one run.

## Reporting a bug

The most useful bug report contains the numbers:

- the curve configuration (`curve.to_dict()` / `curve.toJSON()`)
- the rule involved
- the member state before the call
- `now`, and the base value if you can reproduce it
- what you expected, and what you got

With those, the failure becomes a test case in `shared/testcases/`, which is
where every fixed bug in this library ends up.

## Security

Please do not open a public issue for a security problem. See
[SECURITY.md](./SECURITY.md).
