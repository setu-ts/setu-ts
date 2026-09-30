/**
 * Pending sign-in entry storage (plan §3.5): the five-entry cap, expiry on a
 * controllable clock, and single use.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  addPending,
  MAX_PENDING_ENTRIES,
  PENDING_SESSION_KEY,
  PENDING_TTL_MS,
  takePending,
} from '../../src/sign-in/pending-state.ts';
import type { PendingEntry } from '../../src/sign-in/pending-state.ts';
import { createFakeSession } from '../fixtures/fake-session.ts';

const NOW = 1_700_000_000_000;

function entry(state: string, overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    state,
    provider: 'acme',
    verifier: `verifier-${state}`,
    nonce: `nonce-${state}`,
    returnTo: '/home',
    createdAt: NOW,
    ...overrides,
  };
}

describe('pending-state', () => {
  it('stores an entry and hands it back exactly once', () => {
    const session = createFakeSession();
    addPending(session, entry('s1'));

    const first = takePending(session, 's1', 'acme', NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.entry.verifier).toBe('verifier-s1');
    expect(first.entry.nonce).toBe('nonce-s1');
    expect(first.entry.returnTo).toBe('/home');

    // Single use: the entry is gone from the session the browser now holds.
    const second = takePending(session, 's1', 'acme', NOW);
    expect(second).toEqual({ ok: false, reason: 'unknown-state' });
    expect(session.get<unknown[]>(PENDING_SESSION_KEY)).toEqual([]);
  });

  it('removes the entry before the caller can use it, even on a rejection', () => {
    const session = createFakeSession();
    addPending(session, entry('s1'));
    // An expired read must still clear the entry: it cannot be retried later.
    expect(takePending(session, 's1', 'acme', NOW + PENDING_TTL_MS + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(takePending(session, 's1', 'acme', NOW)).toEqual({ ok: false, reason: 'unknown-state' });
  });

  it('evicts the oldest beyond the cap', () => {
    const session = createFakeSession();
    for (let index = 0; index < MAX_PENDING_ENTRIES + 2; index++) {
      addPending(session, entry(`s${index}`));
    }
    const stored = session.get<PendingEntry[]>(PENDING_SESSION_KEY);
    expect(stored?.length).toBe(MAX_PENDING_ENTRIES);
    // The two oldest are gone; the newest five survive, oldest first.
    expect(stored?.map((storedEntry) => storedEntry.state)).toEqual(['s2', 's3', 's4', 's5', 's6']);
    expect(takePending(session, 's0', 'acme', NOW)).toEqual({ ok: false, reason: 'unknown-state' });
    expect(takePending(session, 's6', 'acme', NOW).ok).toBe(true);
  });

  it('expires an entry on the runtime clock, boundary inclusive', () => {
    const session = createFakeSession();
    addPending(session, entry('s1'));
    expect(takePending(session, 's1', 'acme', NOW + PENDING_TTL_MS).ok).toBe(true);

    addPending(session, entry('s2'));
    expect(takePending(session, 's2', 'acme', NOW + PENDING_TTL_MS + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a state issued for another provider', () => {
    const session = createFakeSession();
    addPending(session, entry('s1', { provider: 'acme' }));
    expect(takePending(session, 's1', 'other', NOW)).toEqual({
      ok: false,
      reason: 'wrong-provider',
    });
    // Still consumed: a mix-up attempt burns the entry rather than leaving it.
    expect(takePending(session, 's1', 'acme', NOW)).toEqual({ ok: false, reason: 'unknown-state' });
  });

  it('refuses a missing, empty or unknown state', () => {
    const session = createFakeSession();
    addPending(session, entry('s1'));
    for (const state of [null, '', 'nope']) {
      expect(takePending(session, state, 'acme', NOW)).toEqual({
        ok: false,
        reason: 'unknown-state',
      });
    }
    // A rejected lookup leaves the real entry alone.
    expect(takePending(session, 's1', 'acme', NOW).ok).toBe(true);
  });

  it('survives an application that cleared or corrupted the key', () => {
    for (const value of [undefined, 'string', {}, [], [{}], [entry('s1', { state: 7 as never })]]) {
      const session = createFakeSession({ [PENDING_SESSION_KEY]: value });
      expect(takePending(session, 's1', 'acme', NOW)).toEqual({
        ok: false,
        reason: 'unknown-state',
      });
    }
  });

  it('keeps insertion order for an all-digit state', () => {
    // A base64url state can be all digits. An object keyed by state would sort
    // those keys numerically and evict the newest, so entries are an array.
    const session = createFakeSession();
    for (const state of ['9', '10', '11']) {
      addPending(session, entry(state), 2);
    }
    expect(session.get<PendingEntry[]>(PENDING_SESSION_KEY)?.map((e) => e.state)).toEqual([
      '10',
      '11',
    ]);
  });
});
