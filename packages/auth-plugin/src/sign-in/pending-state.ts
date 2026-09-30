/**
 * Pending sign-in attempts, held in the session between login and callback.
 * Internal: written by the login route, consumed by the callback route.
 *
 * One entry carries everything the callback must match against an attempt this
 * server actually started: the `state` it issued, the PKCE verifier, the OIDC
 * nonce, the provider the attempt began at, and the post-sign-in target. An
 * entry is removed when the callback reads it, BEFORE any token request, so a
 * replayed callback finds nothing.
 *
 * Entries are an ordered ARRAY, not an object keyed by `state`: a base64url
 * `state` can be all digits, and a JS object reorders integer-like keys, which
 * would silently break "evict the oldest".
 *
 * @module
 */

import type { ISession } from '@setu-ts/common';

/** The reserved session key holding the pending-entry array. */
export const PENDING_SESSION_KEY = '__setu_auth_pending';

/** Pending entries per session, before the oldest start being evicted. */
export const MAX_PENDING_ENTRIES = 3;

/** How long an entry may sit before the callback refuses it, in milliseconds. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** One sign-in attempt awaiting its provider callback. */
export interface PendingEntry {
  /** The `state` this server issued, and the array's logical key. */
  readonly state: string;
  /** The provider the attempt began at; the callback must match it. */
  readonly provider: string;
  /** The PKCE verifier, sent to the token endpoint. */
  readonly verifier: string;
  /** The OIDC nonce; absent for a plain `oauth2` provider. */
  readonly nonce?: string;
  /** The validated post-sign-in redirect target. */
  readonly returnTo: string;
  /** When the entry was created, from `runtime.now()`. */
  readonly createdAt: number;
}

/** A pending entry read out of a session payload, JSON-round-tripped. */
type StoredEntry = Partial<PendingEntry>;

/** The reason a callback did not get a usable entry. */
export type PendingMiss = 'unknown-state' | 'wrong-provider' | 'expired';

/** The outcome of consuming an entry. */
export type PendingOutcome =
  | { readonly ok: true; readonly entry: PendingEntry }
  | { readonly ok: false; readonly reason: PendingMiss };

/**
 * Reads the entry array from a session payload, skipping malformed rows.
 *
 * The payload survives a JSON round-trip and an application can clear or corrupt
 * the key, so every row is validated rather than trusted.
 *
 * @param session - The request's session
 * @returns The well-formed entries, oldest first as stored
 */
function readEntries(session: ISession): PendingEntry[] {
  const raw = session.get<unknown>(PENDING_SESSION_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: PendingEntry[] = [];
  for (const item of raw as StoredEntry[]) {
    if (
      typeof item?.state === 'string' &&
      typeof item.provider === 'string' &&
      typeof item.verifier === 'string' &&
      typeof item.returnTo === 'string' &&
      typeof item.createdAt === 'number'
    ) {
      // `nonce` is omitted rather than set to `undefined`: the project compiles
      // with exactOptionalPropertyTypes, and an entry written for a plain
      // oauth2 provider genuinely has no nonce field.
      entries.push({
        state: item.state,
        provider: item.provider,
        verifier: item.verifier,
        ...(typeof item.nonce === 'string' ? { nonce: item.nonce } : {}),
        returnTo: item.returnTo,
        createdAt: item.createdAt,
      });
    }
  }
  return entries;
}

/**
 * Adds an entry, evicting the oldest once the cap is exceeded.
 *
 * @param session - The request's session, mutated in place
 * @param entry - The attempt just started
 * @param maxEntries - Cap before eviction; internal seam for tests
 */
export function addPending(
  session: ISession,
  entry: PendingEntry,
  maxEntries: number = MAX_PENDING_ENTRIES,
): void {
  const entries = readEntries(session);
  // A repeated login with the same state is impossible by construction (state is
  // fresh per attempt); filtering keeps a re-entry idempotent all the same.
  const kept = entries.filter((existing) => existing.state !== entry.state);
  kept.push(entry);
  session.set(PENDING_SESSION_KEY, kept.slice(-maxEntries));
}

/**
 * Consumes the entry for `state`: validates it, then removes it from the session
 * before the caller is handed it, so a replay cannot reuse it.
 *
 * @param session - The request's session, mutated in place
 * @param state - The `state` the provider returned
 * @param provider - The provider the callback route belongs to
 * @param now - Current wall-clock time in milliseconds
 * @param ttlMs - Age past which the entry is refused; internal seam for tests
 * @returns The entry, or why the callback must fail closed
 */
export function takePending(
  session: ISession,
  state: string | null,
  provider: string,
  now: number,
  ttlMs: number = PENDING_TTL_MS,
): PendingOutcome {
  if (typeof state !== 'string' || state.length === 0) {
    return { ok: false, reason: 'unknown-state' };
  }
  const entries = readEntries(session);
  const entry = entries.find((candidate) => candidate.state === state);
  if (entry === undefined) {
    return { ok: false, reason: 'unknown-state' };
  }
  // Remove first: every branch below must leave the entry gone.
  session.set(
    PENDING_SESSION_KEY,
    entries.filter((candidate) => candidate.state !== state),
  );
  // An entry issued by provider A and presented at provider B's callback is a
  // mix-up attempt; the state was never meant for this route.
  if (entry.provider !== provider) {
    return { ok: false, reason: 'wrong-provider' };
  }
  if (now - entry.createdAt > ttlMs) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, entry };
}
