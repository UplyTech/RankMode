import type { Curve } from "./curves.js";
import { ValidationError } from "./errors.js";
import { TieMode, type LeaderboardEntry, type LeaderboardInput } from "./types.js";

/** Options for {@link buildLeaderboard}. */
export interface LeaderboardOptions {
  /** How members holding the same total are numbered. */
  readonly tieMode?: TieMode;
  /** Rows to skip after ranking. Ranks stay absolute. */
  readonly offset?: number;
  /** Maximum rows to return. */
  readonly limit?: number;
}

/**
 * Turn a list of totals into a ranked leaderboard.
 *
 * The library ranks; it does not fetch. Sorting a hundred thousand rows is a
 * job for the database that already holds them, so the caller selects the rows
 * it wants to show and hands them over. What the library contributes is the
 * part that is easy to get wrong and identical everywhere: the tie handling.
 *
 * Ties keep the order in which they were handed in. That is a deliberate
 * choice over a tie-break on the member id: string comparison differs between
 * Python (code points) and JavaScript (UTF-16 code units) for characters
 * outside the basic plane, and the two editions must never disagree.
 */
export function buildLeaderboard(
  curve: Curve,
  rows: readonly LeaderboardInput[],
  options: LeaderboardOptions = {},
): LeaderboardEntry[] {
  const tieMode = options.tieMode ?? TieMode.Competition;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? null;

  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError("offset must be a non-negative integer", { offset });
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    throw new ValidationError("limit must be a non-negative integer or null", { limit });
  }

  // Decorate with the input index so the sort is stable in every runtime,
  // not only in the ones that promise a stable sort.
  const decorated = rows.map((row, index) => {
    if (typeof row.memberId !== "string" || row.memberId.length === 0) {
      throw new ValidationError("Every leaderboard row needs a non-empty memberId", {
        index,
      });
    }
    if (!Number.isSafeInteger(row.totalXp)) {
      throw new ValidationError("Leaderboard totals must be safe integers", {
        index,
        totalXp: row.totalXp,
      });
    }
    return { row, index };
  });

  decorated.sort((a, b) => {
    if (a.row.totalXp !== b.row.totalXp) {
      return b.row.totalXp - a.row.totalXp;
    }
    return a.index - b.index;
  });

  const entries: LeaderboardEntry[] = [];
  let competitionRank = 0;
  let denseRank = 0;
  let previousTotal: number | null = null;

  for (let position = 0; position < decorated.length; position += 1) {
    const item = decorated[position];
    if (item === undefined) {
      continue;
    }
    const { totalXp, memberId } = item.row;
    if (previousTotal === null || totalXp !== previousTotal) {
      competitionRank = position + 1;
      denseRank += 1;
      previousTotal = totalXp;
    }
    const progress = curve.progressForTotalXp(totalXp);
    const rank =
      tieMode === TieMode.Dense
        ? denseRank
        : tieMode === TieMode.Ordinal
          ? position + 1
          : competitionRank;

    entries.push({
      memberId,
      totalXp,
      level: progress.level,
      rank,
      competitionRank,
      denseRank,
      position,
      progress,
    });
  }

  const start = offset;
  const end = limit === null ? entries.length : start + limit;
  return entries.slice(start, end);
}

/**
 * The rank of a single member inside a set of totals.
 *
 * Returns `null` when the member is not in the list. Useful for the
 * "you are #47" line under a level card, where fetching the whole board
 * would be wasteful.
 */
export function rankOf(
  memberId: string,
  rows: readonly LeaderboardInput[],
  options: { tieMode?: TieMode } = {},
): number | null {
  const tieMode = options.tieMode ?? TieMode.Competition;
  const targetIndex = rows.findIndex((row) => row.memberId === memberId);
  if (targetIndex === -1) {
    return null;
  }
  const targetTotal = (rows[targetIndex] as LeaderboardInput).totalXp;

  if (tieMode === TieMode.Dense) {
    const higherTotals = new Set<number>();
    for (const row of rows) {
      if (row.totalXp > targetTotal) {
        higherTotals.add(row.totalXp);
      }
    }
    return higherTotals.size + 1;
  }

  if (tieMode === TieMode.Ordinal) {
    // The index comes from the loop, not from `rows.indexOf` inside it: until
    // 2.0.0 this was a linear scan per row, which made the whole call O(n^2)
    // while the Python edition was O(n). SECURITY.md counts "a leaderboard size
    // that makes a call take unreasonably long" as a vulnerability.
    let position = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const total = (rows[index] as LeaderboardInput).totalXp;
      if (total > targetTotal) {
        position += 1;
      } else if (total === targetTotal && index < targetIndex) {
        // Ties keep input order, so only rows before the target count.
        position += 1;
      }
    }
    return position + 1;
  }

  let ahead = 0;
  for (const row of rows) {
    if (row.totalXp > targetTotal) {
      ahead += 1;
    }
  }
  return ahead + 1;
}

/**
 * Split a leaderboard into pages of a fixed size.
 *
 * A small convenience, but it is the operation every caller writes next and
 * gets subtly wrong at the last page.
 */
export function paginate(
  entries: readonly LeaderboardEntry[],
  pageSize: number,
  page: number,
): LeaderboardEntry[] {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError("pageSize must be a positive integer", { pageSize });
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError("page is 1-based and must be a positive integer", { page });
  }
  const start = (page - 1) * pageSize;
  return entries.slice(start, start + pageSize);
}

/** How many pages a board of this size has. */
export function pageCount(total: number, pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ValidationError("pageSize must be a positive integer", { pageSize });
  }
  if (total <= 0) {
    return 0;
  }
  return Math.ceil(total / pageSize);
}
