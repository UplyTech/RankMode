# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both language editions share one version number and one history. A release
happens for both at once, or not at all — two editions on different versions
would be exactly the drift the shared test vectors exist to prevent.

## [Unreleased]

### Changed

- **Node 22.12 or newer** (`engines.node` was `>=20.0.0`). Node 20 is end-of-life, and CI tests on Node 22 and 24 only.
- **Licence: Apache License 2.0** (was MIT). `LICENSE` carries the full Apache text, `NOTICE` the attribution `Copyright (c) 2021-present UplyTech` (UplyTech has existed as a community since 2021); both ship in the npm package, the wheel and the sdist. Author fields name UplyTech only.
- PyPI distribution name `uplytech-rankmode` (was `rankmode`); the import name is unchanged. npm stays `@uplytech/rankmode`.
- Releases publish to npm and PyPI with Trusted Publishing (OIDC, no registry token) and npm provenance, after the signed GitHub release. Each registry is switched on with a repository variable once its Trusted Publisher exists. Every artefact also gets a GitHub build attestation.
- CI runs on GitHub-hosted runners, since the repository is public and the organisation runner serves private repositories only. Pull requests are validated again (read-only token, no secrets); CodeQL, dependency review and a published OpenSSF Scorecard are part of the checks.
- Repository links point to `github.com/UplyTech/RankMode`.
- `NOTICE` names the licensor in full: UplyTech, Tim Hauke, Albert-Schweitzer-Ring 42, 25524 Itzehoe, Germany. Python metadata uses the PEP 639 fields (`license = "Apache-2.0"`, `license-files`); the wheel carries `LICENSE` and `NOTICE` under `licenses/`.
- Test toolchain: Vitest 5, ESLint 9 with a flat config, typescript-eslint 8. This clears the advisories in the old Vitest/Vite/esbuild dev tree (none of it reached a caller). The test matrix runs Node 22 and 24; Node 20 is end-of-life and Vitest 5 needs 22.12 or newer.
- Releases start only from a pushed `v*` tag on `main`; the manual trigger is gone. The registry jobs run in the environment `release` (only `v*` tags, the owner approves). Tool images in CI are pinned by digest. The Python dependency audit runs against the pinned dev environment and fails on any finding.

## [3.0.0] - 2026-09-08

**RankMode ranks two different things now.** Until 2.0.0 it answered one
question — how much experience did somebody earn for taking part — and a caller
who wanted to know who was *better* had to build that themselves. This release
adds the second half: ratings, ladders, seasons, placements, promotion series
and matchmaking, as a complete competitive system with nothing left to write.

The participation half is untouched. `RankEngine`, curves, leaderboards,
multipliers, decay and migration all behave exactly as they did in 2.0.0, and
every 2.0.0 shared vector still passes unchanged. **No existing caller has
anything to migrate.**

The major version is for the surface, not for a behaviour change: fifty-nine new
exported names, of which two are error classes, and a second engine.

### For operators, in three sentences

1. **If you use RankMode for XP and levels, upgrading changes nothing.** The
   participation half is byte-identical; the new code is only reached by calls
   you have not written yet.
2. **If you want a competitive ladder, it is now here** — `RankedEngine`, and
   the five-minute example in the README.
3. **Glicko-2 is the default and it costs about fifty microseconds a match**;
   Elo costs two. Both are exact and identical across the editions, and the
   difference is the volatility solve. Twenty thousand ranked matches a second
   on one core is the ceiling, which is far past any load a ladder sees.

### Added — the ranked system

- **`RankedEngine`**, the one object a caller holds. A match goes in, a new
  state comes out, and the order of operations is fixed and documented because a
  different order produces different numbers.
- **Two rating systems.** **Glicko-2** (the default) carries a rating, a
  deviation and a volatility, so an uncertain player moves fast, a settled one
  moves slowly, and a player who stops playing becomes uncertain again on their
  own. **Elo** is there for the caller who needs a number a player can compute
  in their head. The implementation reproduces Glickman's own worked example to
  the last digit his paper prints, and that example is a test.
- **A nine-tier ladder** — Iron to Challenger, four divisions each below the
  apex three — with League Points, promotion series, demotion protection and
  configurable floors. It is deliberately a separate number from the rating:
  the matchmaker gets to be honest while the display gets to be kind.
- **Seasons**, with a soft reset that pulls a rating part of the way to the mean
  and widens its uncertainty rather than throwing four months of play away.
- **Placements**, so nobody is shown a rank on their first evening, and the rank
  they eventually get is seeded from what the rating learned.
- **Matchmaking**: how even a proposed match is, whether it is worth running,
  what a team of players is worth as one rating, and the closest split of a
  group into two teams.
- **Deterministic fixed-point arithmetic** (`rankmode.fixed` / `src/fixed.ts`):
  `exp`, `ln`, `sqrt`, multiplication and division on integers. IEEE 754 pins
  down the four basic operations to the last bit and does *not* pin down the
  transcendental ones, so `Math.exp` here and `math.exp` there are free to
  differ in the last place — and a rating one micro-unit either side of a
  promotion threshold is a player promoted in one edition and not the other.
- **`LadderError` and `SeasonError`**, both extending `RankModeError`.

### Added — testing

- **`shared/testcases/ranked.json`**: 2,243 vectors covering every function
  above, and four whole seasons replayed match by match. The season vectors are
  the valuable ones — they are the only thing in the suite that catches a
  divergence needing a hundred updates of accumulated state before it appears.
- **Four new case kinds in the differential fuzzer** (`rating`, `ladder`,
  `ranked`, `matchmaking`), biased towards the rating gaps where Glicko-2's
  estimated variance blows up. It found a real bug in both editions on its
  first serious run; see below.
- Property suites in both editions for the ranked half, and complexity ceilings
  so a change from linear to quadratic fails a build rather than a customer.

### Fixed — found while building this

Three of these are defects in code that never shipped, written down because the
reasoning is worth keeping and because each is a trap the next implementation
would fall into:

- **The volatility solver did not converge.** Glickman specifies the Illinois
  variant of regula falsi, which is right in floating point and has no
  termination guarantee on integers: once the bracket is narrow the rounding
  sends the secant step to the same two points for ever, a two-cycle 122
  micro-units wide that no iteration count escapes. It bisects instead — slower,
  always terminating, and identical in both editions.
- **The volatility solver's bracket left the representable domain.** After a
  sufficiently improbable result — a 200-rated player beating a 2200-rated one —
  Glickman's upper end `ln(delta² - phi² - v)` passes 22, outside the ±20 domain
  the fixed-point `exp` is defined on. 816 of 4,800 swept inputs raised. The
  bracket is now clamped into the configured volatility bounds, and the
  estimated variance is capped: `delta²` reached 10¹⁸, which is 111 times past
  the largest integer JavaScript represents exactly, so this was also the point
  where the TypeScript edition would have started returning numbers the Python
  one did not.
- **An idle player's deviation stopped growing at 109.** `phi* = sqrt(phi² +
  sigma²)` is computed from the deviation as it is stored, in whole rating
  points, and past 109 one period's growth is under half a point: it rounds back
  to the number it started from, and that number becomes a fixed point of the
  iteration. A player gone for two years was still treated as one the system
  knew to within a hundred points. An idle period now always widens the
  deviation, by at least one point, up to the cap.
- **`match_quality` gave a different answer depending on which side was listed
  first.** Glicko-2's expected score damps by the *opponent's* deviation, so the
  two directions are two different calculations agreeing to within a rounding
  step — and the quality is quadratic in the imbalance, which turned one
  permille into three. A queue would have had a bug nobody could reproduce.
- **A rating below the lowest tier threshold produced an impossible position.**
  Found by the differential fuzzer, in both editions at once: the offset into
  the tier went negative, the floor division sent the division index to -1, and
  Python raised `ValueError` while TypeScript cast the -1 and returned a
  position carrying division zero that no other function accepts. A rating below
  the bottom of the ladder now seeds to the bottom of the ladder.
- **`fromFixed` could return `-0`** in the TypeScript edition, the same defect
  class as `awardedXp` in 2.0.0. Python has no negative zero, so it was a number
  the two editions spelled differently.

### Verification

- 738 Python tests, 548 TypeScript tests. 98.5 % and 98.9 % coverage.
- 24,905 values swept across every ranked function in both editions: no
  divergence.
- 6,000 generated differential cases over three seeds and ten case kinds: no
  divergence.

## [2.0.0] - 2026-09-08

**The two editions did not agree, and the whole library rests on the claim that
they do.** Three separate code paths in the TypeScript edition computed
different numbers than the Python edition. All three are fixed here, and a
differential fuzzer now runs on every pull request so the next one is found by a
machine rather than by an audit.

A major version, because fixing them changes what a curve computes — and
CONTRIBUTING.md allows no exception for that, "no matter how obviously the old
number was wrong".

### For operators, in three sentences

1. **If your curve uses a `base` below about 6 × 10¹², nothing changes for your
   members.** That is every realistic configuration.
2. **If it does not, some members' levels move.** The Python edition was already
   right; the TypeScript edition now agrees with it. Run `preview_migration()`
   before upgrading.
3. **A member sitting at the top of your curve no longer gains a free level when
   you extend it** — see the migration fix below, which is the change most
   likely to be visible.

### Fixed — the editions now agree

- **`ExponentialCurve` built a different threshold table in each edition.**
  `cost * growthPermille` passed `2^53 - 1` while `cost`, the factor and the
  answer all stayed inside it, so JavaScript rounded where Python was exact.
  Four of 78 tested specifications produced different tables, and every level
  above the first divergence was shifted with it.
- **`applyMultipliers` and `combinedPermille` returned different amounts.**
  1871 of 4000 random `(baseXp, permille)` pairs disagreed once the base was
  large — reachable through the documented `baseXp` override and through a long
  multiplier chain.
- **`progressForTotalXp` reported a different bar.** 7636 of 149912 targeted
  samples disagreed for levels wider than about 9 × 10¹², which a `TabularCurve`
  can be handed directly.
- All three had one cause, and now one fix: `mulDivFloor` in
  `typescript/src/exact.ts` computes `floor(a * b / c)` exactly whatever the
  size of the product. The Python edition needed no change; it was the correct
  one throughout.
- **`awardedXp` could be `-0`** in the TypeScript edition. JavaScript has a
  negative zero and Python's integers do not, so `Object.is(result.awardedXp, 0)`
  answered differently in the two editions.

### Fixed — behaviour

- **A migration no longer hands out a free level.** A member at the top of the
  old curve reports a full bar — 1000 permille, because there is no next level
  to be part-way to — and `PRESERVE_PROGRESS` carried that full bar into the new
  curve, landing them exactly on its next threshold. Extending a curve from 20
  to 50 levels promoted **every** maxed member. Found by a property test; no
  vector covered it.
- **Decay could not see activity from a rule without a cooldown.**
  `lastEventAt` was written only when `cooldownSeconds > 0`, and decay reads it
  to find the member's last activity — so a member earning every day through
  `voice_minute` decayed anyway. It is now stamped on every paying award.
- **Decay restarted its own grace window.** For a member with no recorded
  activity the grace period was measured from the last decay run, so every run
  pushed it forward — the exact failure the code comment says the function
  prevents. Decay ran once per *grace* period instead of once per decay period:
  40 daily runs removed 400 XP where the operator had configured 3900.
- **`rankmode.engine.__all__` advertised `create_member_state`** without the
  module ever importing it, so `from rankmode.engine import create_member_state`
  raised `ImportError` and `import *` raised `AttributeError`.
- **The TypeScript edition accepted unvalidated rules.** A shape heuristic
  decided whether to run `createEventRule`, so a hand-written object carrying
  all seven fields skipped every check — including a fractional `minXp`, which
  produced a fractional total, and the reserved `*` event type, which collides
  with the global cap's own bookkeeping key. Every rule is now validated.
- **`rankOf` in `ORDINAL` mode was O(n²)** in the TypeScript edition, from a
  `rows.indexOf` inside the loop over `rows`. SECURITY.md counts a leaderboard
  size that makes a call take unreasonably long as a vulnerability.

### Changed — breaking

- **`clampedToKeepLevel` is now `clampedToCurveTop`** (`clamped_to_keep_level` →
  `clamped_to_curve_top`). The old name and its documentation both said the
  opposite of what the field was ever set for: it marks a member placed at the
  top of a *shorter* new curve. A boolean whose name is the negation of its
  meaning produces a correct-looking `if` that is backwards.
- **`applyMultipliers` and `combinedPermille` raise `XpOverflowError`** when the
  running value leaves the shared safe range, instead of returning a number only
  Python can hold. This is the first thing that ever raised that class.
- **`progressForTotalXp` raises `XpOverflowError`** when a *reported* value would
  leave the safe range. Unreachable for any total of zero or above, so it needs
  `allowNegative` and an extreme negative total.
- **Both editions now validate the same inputs.** TypeScript requires `now` and
  `totalXp` to be integers, as Python always did; Python rejects a non-finite
  `xpPerHour` with `ValidationError` instead of leaking a bare `ValueError` from
  `math.ceil` for `NaN` and silently returning `0` for `Infinity`.

### Added

- **`shared/tools/differential/`** — a seeded generator, a runner in each
  edition and a comparison. It produces cases nobody wrote down, biased toward
  `2^53` and toward every threshold, cap and level boundary. `parity` runs it on
  every pull request with a fixed seed; `security.yml` runs 200,000 random cases
  nightly. The shared vectors catch a regression in something somebody already
  imagined; this catches the rest.
- `AwardResult.changed` and `LevelProgress.progressRatio` in the TypeScript
  edition, so both editions answer "do I need to write?" the same way.
- **Wider shared vectors.** `curves.json` and `multipliers.json` now probe the
  magnitudes at which the editions used to disagree, and `migration.json` covers
  extending a curve — the change that produced the free level.
- **`.github/`** — CI across 4 Python and 3 Node versions on three platforms,
  vector-drift detection, a job that installs the built wheel and tarball and
  uses them, CodeQL, dependency review, OSV, Scorecard, and a release workflow
  publishing to PyPI and npm from one run with provenance and signed
  attestations. `.github/SETTINGS.md` records the settings that cannot be
  committed.
- Test suites grew from 279 to 371 (Python) and from 194 to 277 (TypeScript),
  including property-based tests, magnitude tests at `2^53`, complexity ceilings
  and a check that every name in `__all__` can actually be imported.

### Fixed — packaging

- The npm lockfile was gitignored, so `npm ci` was impossible on a fresh clone.
- `LICENSE` and `CHANGELOG.md` are generated into each edition and gitignored,
  so a publish from a fresh clone shipped **no licence file**. Generating them
  is now a build step, and CI proves it.
- The scoped package had no `publishConfig.access`, so the first `npm publish`
  would have gone out private.
- `exports` pointed the ESM condition's types at the CommonJS declarations —
  `arethetypeswrong` reported "Masquerading as CJS" for every `node16` ESM
  consumer.

## [1.0.0] - 2026-09-05

First release. The public interface is stable from here: see
[CONTRIBUTING.md](./CONTRIBUTING.md) for what may change in a minor version and
what may not.

### Added — core

- `RankEngine.award()` — points for an event, with a fixed and documented order
  of checks: rule lookup, enabled, cooldown, roll, multipliers, period caps,
  ceiling. The order is part of the public contract because a different order
  produces different numbers.
- `RankEngine.penalize()` — the counterpart moderation needs, with level-loss
  reporting and an optional cooldown reset so the points cannot be farmed
  straight back.
- `RankEngine.apply_decay()` / `applyDecay()` — optional decay charged per whole
  elapsed period, so running it daily and running it monthly cost the same.
- `RankEngine.estimate_time_to_level()` — the "when do I level up?" answer.
- Outcomes instead of exceptions for the normal cases: `COOLDOWN`, `PERIOD_CAP`,
  `RULE_DISABLED`, `UNKNOWN_EVENT`, `MAX_XP_REACHED`, `NO_XP`.

### Added — curves

- `LinearCurve`, `QuadraticCurve` (the default), `ExponentialCurve` and
  `TabularCurve` for operator-supplied thresholds.
- Every curve materialises a threshold table at construction instead of
  evaluating a formula on demand — the mechanism that makes identical results in
  both editions provable rather than likely.
- Progress reported in permille (0..1000) as integers, never as floats.

### Added — abuse resistance

- Random award spans, backed by a caller-supplied random source.
- Cooldowns per member and event type. A blocked attempt does **not** restart
  the cooldown.
- Period caps per rule, plus one global cap across all event types. The tighter
  of the two applies, and the last award of a period is trimmed rather than
  refused.
- A shared ceiling of `2^53 - 1` in both editions, so no total can exist that
  only one of them can hold.

### Added — leaderboards

- `build_leaderboard()` with three tie modes: competition (1, 2, 2, 4), dense
  (1, 2, 2, 3) and ordinal (1, 2, 3, 4). All three numberings are reported on
  every row.
- Ties keep input order — deliberately, because Python and JavaScript disagree
  about string comparison outside the basic multilingual plane.
- `rank_of()` for a single member, `paginate()` and `page_count()` for paging.

### Added — curve migration

- `migrate_total_xp()` with three strategies: `PRESERVE_PROGRESS` (default),
  `PRESERVE_LEVEL` and `PRESERVE_XP`.
- `preview_migration()` reports what a curve change would do to a whole scope
  before anything is written, including whether any member would lose a level.

### Added — state and persistence

- `MemberState` with `serialize`/`deserialize` helpers using the same JSON field
  names in both editions, so a bot ported from Python to TypeScript keeps its
  data.
- `prune_member_state()` to drop cooldown stamps that can no longer block
  anything.

### Added — cross-edition guarantee

- `shared/testcases/` — vectors for curves, multipliers, the seeded random
  source, full award sequences, leaderboards and migrations. Both test suites
  run them.
- `typescript/scripts/generate-shared-vectors.mjs` regenerates them. Doing so is
  a deliberate act: a changed vector means changed behaviour, and that belongs
  in this file with a version bump.

### Decisions worth recording

- **Python first**, against the general package standard that puts TypeScript
  first. Every current caller is a Python bot; a TypeScript-first release would
  have had zero callers.
- **No storage.** Every caller already has a database; a second one would be a
  second truth, and it would drag personal data into the library.
- **No Discord binding.** The moment the library knows what a message is, it
  stops working for a forum.
- **Time and randomness are parameters.** Neither is read from the environment,
  because neither would then be testable.
- **Integers everywhere**, multipliers in permille. Floating point in a level
  formula produces rounding differences between editions.

[3.0.0]: https://github.com/uplytech/rankmode/releases/tag/v3.0.0
[2.0.0]: https://github.com/uplytech/rankmode/releases/tag/v2.0.0
[1.0.0]: https://github.com/uplytech/rankmode/releases/tag/v1.0.0
