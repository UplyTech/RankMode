import { ValidationError } from "./errors.js";
import type { MemberState } from "./types.js";

/**
 * Helpers around {@link MemberState}.
 *
 * The state is a plain object on purpose: the caller has to store it in its
 * own database, and a plain object survives `JSON.stringify`, a JSONB column
 * and a document store without a mapper.
 */

/** A fresh state for a member who has not earned anything yet. */
export function createMemberState(totalXp = 0): MemberState {
  if (!Number.isSafeInteger(totalXp)) {
    throw new ValidationError("totalXp must be a safe integer", { totalXp });
  }
  return {
    totalXp,
    lastEventAt: {},
    periodStartAt: {},
    periodAwardedXp: {},
    lastDecayAt: null,
  };
}

/** Deep copy. The engine never mutates the state it is handed. */
export function cloneMemberState(state: MemberState): MemberState {
  return {
    totalXp: state.totalXp,
    lastEventAt: { ...state.lastEventAt },
    periodStartAt: { ...state.periodStartAt },
    periodAwardedXp: { ...state.periodAwardedXp },
    lastDecayAt: state.lastDecayAt,
  };
}

/** Plain-object form, ready for `JSON.stringify`. */
export function serializeMemberState(state: MemberState): Record<string, unknown> {
  return {
    totalXp: state.totalXp,
    lastEventAt: { ...state.lastEventAt },
    periodStartAt: { ...state.periodStartAt },
    periodAwardedXp: { ...state.periodAwardedXp },
    lastDecayAt: state.lastDecayAt,
  };
}

/**
 * Rebuild a state from stored data.
 *
 * Missing fields are filled with their empty defaults, so a row written by an
 * older version of the calling bot still loads.
 */
export function deserializeMemberState(raw: unknown): MemberState {
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("Member state must be an object", { received: typeof raw });
  }
  const source = raw as Record<string, unknown>;
  const totalXp = source["totalXp"] ?? 0;
  if (typeof totalXp !== "number" || !Number.isSafeInteger(totalXp)) {
    throw new ValidationError("totalXp must be a safe integer", { totalXp });
  }
  const lastDecayAt = source["lastDecayAt"];
  if (
    lastDecayAt !== undefined &&
    lastDecayAt !== null &&
    (typeof lastDecayAt !== "number" || !Number.isFinite(lastDecayAt))
  ) {
    throw new ValidationError("lastDecayAt must be a timestamp or null", { lastDecayAt });
  }

  return {
    totalXp,
    lastEventAt: readNumberMap(source["lastEventAt"], "lastEventAt"),
    periodStartAt: readNumberMap(source["periodStartAt"], "periodStartAt"),
    periodAwardedXp: readNumberMap(source["periodAwardedXp"], "periodAwardedXp"),
    lastDecayAt: (lastDecayAt as number | null | undefined) ?? null,
  };
}

/**
 * Drop entries the engine can no longer need.
 *
 * A long-lived member accumulates one `lastEventAt` entry per event type they
 * ever triggered. This removes the cooldown stamps that expired longer than
 * `keepCooldownMs` ago, so the stored row stays small.
 *
 * Period counters are deliberately left alone: whether one is spent depends on
 * the rule's `periodSeconds`, which the state does not carry, so pruning them
 * here would need the engine's configuration and would silently hand a member
 * a fresh period cap.
 */
export function pruneMemberState(
  state: MemberState,
  options: { now: number; keepCooldownMs?: number },
): MemberState {
  const keep = options.keepCooldownMs ?? 0;
  const pruned = cloneMemberState(state);
  for (const [key, at] of Object.entries(pruned.lastEventAt)) {
    if (options.now - at > keep) {
      delete pruned.lastEventAt[key];
    }
  }
  return pruned;
}

function readNumberMap(value: unknown, field: string): Record<string, number> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object") {
    throw new ValidationError(`${field} must be an object`, { field });
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new ValidationError(`${field} contains a non-numeric value`, { key, entry });
    }
    result[key] = entry;
  }
  return result;
}
