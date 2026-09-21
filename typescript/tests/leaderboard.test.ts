import { describe, it, expect } from "vitest";
import {
  buildLeaderboard,
  pageCount,
  paginate,
  QuadraticCurve,
  rankOf,
  TieMode,
  ValidationError,
} from "../src/index.js";

const curve = new QuadraticCurve({ base: 100, maxLevel: 50 });

const rows = [
  { memberId: "ana", totalXp: 500 },
  { memberId: "ben", totalXp: 900 },
  { memberId: "cai", totalXp: 500 },
  { memberId: "dee", totalXp: 100 },
  { memberId: "eli", totalXp: 900 },
];

describe("buildLeaderboard", () => {
  it("sorts by total, highest first", () => {
    const board = buildLeaderboard(curve, rows);
    expect(board.map((entry) => entry.memberId)).toEqual([
      "ben",
      "eli",
      "ana",
      "cai",
      "dee",
    ]);
  });

  it("numbers ties with competition ranking by default", () => {
    const board = buildLeaderboard(curve, rows);
    expect(board.map((entry) => entry.rank)).toEqual([1, 1, 3, 3, 5]);
  });

  it("numbers ties without gaps in dense mode", () => {
    const board = buildLeaderboard(curve, rows, { tieMode: TieMode.Dense });
    expect(board.map((entry) => entry.rank)).toEqual([1, 1, 2, 2, 3]);
  });

  it("gives every row its own number in ordinal mode", () => {
    const board = buildLeaderboard(curve, rows, { tieMode: TieMode.Ordinal });
    expect(board.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("always reports both tie numberings for reference", () => {
    const board = buildLeaderboard(curve, rows, { tieMode: TieMode.Ordinal });
    expect(board.map((entry) => entry.competitionRank)).toEqual([1, 1, 3, 3, 5]);
    expect(board.map((entry) => entry.denseRank)).toEqual([1, 1, 2, 2, 3]);
  });

  it("keeps input order among tied members", () => {
    // ben comes before eli in the input, so ben stays ahead.
    const board = buildLeaderboard(curve, rows);
    expect(board[0]?.memberId).toBe("ben");
    expect(board[1]?.memberId).toBe("eli");

    const reversed = buildLeaderboard(curve, [...rows].reverse());
    expect(reversed[0]?.memberId).toBe("eli");
  });

  it("attaches level and progress to every row", () => {
    const board = buildLeaderboard(curve, rows);
    const top = board[0];
    expect(top?.level).toBe(3);
    expect(top?.progress.level).toBe(3);
    expect(top?.progress.nextThreshold).toBe(1000);
  });

  it("applies offset and limit after ranking", () => {
    const board = buildLeaderboard(curve, rows, { offset: 2, limit: 2 });
    expect(board.map((entry) => entry.memberId)).toEqual(["ana", "cai"]);
    // Ranks stay absolute so page two still says "3rd", not "1st".
    expect(board.map((entry) => entry.rank)).toEqual([3, 3]);
    expect(board.map((entry) => entry.position)).toEqual([2, 3]);
  });

  it("handles an empty board", () => {
    expect(buildLeaderboard(curve, [])).toEqual([]);
  });

  it("handles a board where everyone is tied", () => {
    const board = buildLeaderboard(
      curve,
      [
        { memberId: "a", totalXp: 10 },
        { memberId: "b", totalXp: 10 },
        { memberId: "c", totalXp: 10 },
      ],
      { tieMode: TieMode.Competition },
    );
    expect(board.map((entry) => entry.rank)).toEqual([1, 1, 1]);
  });

  it("rejects invalid rows and paging arguments", () => {
    expect(() => buildLeaderboard(curve, [{ memberId: "", totalXp: 1 }])).toThrow(
      ValidationError,
    );
    expect(() => buildLeaderboard(curve, [{ memberId: "a", totalXp: 1.5 }])).toThrow(
      ValidationError,
    );
    expect(() => buildLeaderboard(curve, rows, { offset: -1 })).toThrow(ValidationError);
    expect(() => buildLeaderboard(curve, rows, { limit: -1 })).toThrow(ValidationError);
  });

  it("stays fast on a large board", () => {
    const many = Array.from({ length: 10_000 }, (_, index) => ({
      memberId: `m${index}`,
      totalXp: (index * 7919) % 250_000,
    }));
    const started = Date.now();
    const board = buildLeaderboard(curve, many);
    expect(board).toHaveLength(10_000);
    // The concept asks for under 50 ms; the generous bound keeps CI honest
    // without turning a slow runner into a red build.
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("rankOf", () => {
  it("finds a member without building the whole board", () => {
    expect(rankOf("ben", rows)).toBe(1);
    expect(rankOf("eli", rows)).toBe(1);
    expect(rankOf("ana", rows)).toBe(3);
    expect(rankOf("dee", rows)).toBe(5);
  });

  it("agrees with buildLeaderboard in every tie mode", () => {
    for (const tieMode of [TieMode.Competition, TieMode.Dense, TieMode.Ordinal]) {
      const board = buildLeaderboard(curve, rows, { tieMode });
      for (const entry of board) {
        expect(rankOf(entry.memberId, rows, { tieMode })).toBe(entry.rank);
      }
    }
  });

  it("returns null for a member who is not on the board", () => {
    expect(rankOf("nobody", rows)).toBeNull();
  });
});

describe("paginate", () => {
  it("cuts a board into pages", () => {
    const board = buildLeaderboard(curve, rows);
    expect(paginate(board, 2, 1).map((e) => e.memberId)).toEqual(["ben", "eli"]);
    expect(paginate(board, 2, 3).map((e) => e.memberId)).toEqual(["dee"]);
    expect(paginate(board, 2, 4)).toEqual([]);
  });

  it("counts pages", () => {
    expect(pageCount(5, 2)).toBe(3);
    expect(pageCount(4, 2)).toBe(2);
    expect(pageCount(0, 2)).toBe(0);
  });

  it("rejects nonsense paging", () => {
    expect(() => paginate([], 0, 1)).toThrow(ValidationError);
    expect(() => paginate([], 10, 0)).toThrow(ValidationError);
    expect(() => pageCount(10, 0)).toThrow(ValidationError);
  });
});
