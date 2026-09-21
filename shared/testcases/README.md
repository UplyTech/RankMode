# Shared test vectors

These files are the contract between the Python and the TypeScript edition of
RankMode. Both test suites read them and must reproduce every number exactly.

Two editions that quietly compute different levels are worse than four separate
implementations, because nobody expects the difference. These files are half of
how that is prevented.

> **They are half, not all.** A vector file is a list somebody sat down and
> wrote, so it can only catch a regression in something somebody already thought
> of. Three divergences survived the whole of 1.x precisely because nobody
> thought of them: every file here worked below 10⁶, and all three appeared only
> above 2⁵³. The other half is
> [`shared/tools/differential/`](../tools/differential), which generates the
> cases nobody wrote down. Both run in CI, and neither replaces the other — a
> generated failure gets *added here*, so that the specific case is pinned
> forever.

## The files

| File | Pins down |
|---|---|
| `curves.json` | Threshold tables and progress for every curve shape, probed at the awkward totals: 0, one below a threshold, exactly on it, one above, far past the top — and, since 2.0.0, at the magnitudes near 2⁵³ where the two editions used to disagree. |
| `multipliers.json` | Permille multiplier chains, including the orders that show floor division is not commutative. |
| `random.json` | The mulberry32 stream of `SeededRandomSource`, raw and mapped into a span. |
| `awards.json` | Whole award sequences: cooldowns, period caps, global caps, multipliers, penalties, decay. |
| `leaderboard.json` | All three tie modes, single-member ranks, and paging. |
| `migration.json` | Every strategy across every curve pair, including one that clamps, and — since 2.0.0 — a curve simply being *extended*, which used to hand every maxed member a free level. |
| `ranked.json` | The whole competitive half, added in 3.0.0: expected scores, Elo and Glicko-2 updates (including Glickman's own worked example and the idle period), rating intervals, ladder seeding, every ladder transition, promotion series, season resets, match quality, team ratings, team balancing — and four whole seasons replayed match by match. |

### Why `ranked.json` is mostly one section

Every other group in that file is one call with one answer, and a divergence in
one would surface in the first release that shipped it. The `engine` group is
the valuable one: it carries a state forward through a hundred and twenty
matches, which is the only way a divergence that needs accumulated state before
it is a whole rating point ever appears before somebody's ladder is wrong.

Each match records the compact result — the rating delta, the streak, what the
ladder did — and every twentieth match carries the entire serialised state, so a
divergence that appears late can be read off the diff instead of replayed.

## How the editions consume them

| | |
|---|---|
| Python | `python/tests/test_shared_vectors.py`, `python/tests/test_ranked_vectors.py` |
| TypeScript | `typescript/tests/shared-vectors.test.ts`, `typescript/tests/ranked-vectors.test.ts` |

Award scenarios are replayed against a `FixedRandomSource` seeded from the
vector's own `randomValues`. That is deliberate: it means the two editions need
no agreement about a pseudo-random *algorithm* to agree on award *results*.
(`random.json` covers the algorithm separately, for the seeded source.)

## Field naming

Every field uses the JSON (camelCase) spelling — `totalXp`, `periodCapXp`,
`progressPermille`, `leaguePoints`, `matchesSincePromotion` — in both editions. The Python side maps them onto its own
snake_case API when it loads a vector. One spelling in the files keeps the diffs
readable.

## Regenerating

```bash
cd typescript
npm run build
node scripts/generate-shared-vectors.mjs
```

**This is a deliberate act, not a routine step.** If a file here changes, the
behaviour of the library changed:

- a diff in `curves.json` means members' levels move → **major version**
- a diff in `awards.json` means an award computes differently → at least minor,
  usually major
- a diff in `migration.json` means an operator's migration produces different
  totals → major

Review the diff as carefully as you review code, and record it in
`CHANGELOG.md`.

> Never regenerate these files to make a failing test pass. A failing vector is
> the system working: it is telling you the editions have drifted apart, or that
> you changed something you did not intend to. Find out which first.

## Format version

Each file carries a `formatVersion`. The suites assert it, so a vector file from
a future layout fails loudly instead of being half-read.
