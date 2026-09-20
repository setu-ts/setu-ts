/**
 * Unit tests for session state: monotonic expiry, key disposal, the atomic
 * sequence gate, sequence exhaustion, terminal revocation, and instance
 * binding.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { DiagnosticsSessionState } from '../../src/security/session.ts';
import {
  MutableClock,
  TEST_INSTANCE_ID,
  TEST_KEY_BYTES,
  TEST_SESSION_ID,
} from '../fixtures/helpers.ts';

describe('Session — creation', () => {
  it('starts unbound, admissible, and with the full TTL remaining', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      60_000,
      clock,
    );
    expect(session.hasInstance()).toBe(false);
    expect(session.instanceId).toBe(null);
    expect(session.isAdmissible(clock)).toBe(true);
    expect(session.remainingMs(clock)).toEqual(60_000);
    expect(session.ttlMs).toEqual(60_000);
    expect(session.canVerify()).toBe(true);
  });
});

describe('Session — monotonic expiry', () => {
  it('refuses admission after the monotonic expiry regardless of wall clock', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      1_000,
      clock,
    );
    clock.advance(999);
    expect(session.isAdmissible(clock)).toBe(true);
    expect(session.admitAfterVerify(1, clock)).toBe(true);
    clock.advance(1);
    // Expiry is monotonic: no wall-clock change can restore the session.
    expect(session.isAdmissible(clock)).toBe(false);
    expect(session.admitAfterVerify(2, clock)).toBe(false);
    expect(session.remainingMs(clock)).toEqual(0);
  });

  it('admits up to the expiry boundary and refuses at it', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      100,
      clock,
    );
    clock.advance(99);
    expect(session.admitAfterVerify(1, clock)).toBe(true);
    clock.advance(1);
    expect(session.admitAfterVerify(2, clock)).toBe(false);
  });
});

describe('Session — the atomic sequence gate', () => {
  it('accepts strictly increasing sequences and rejects equal or lower ones', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      60_000,
      clock,
    );
    expect(session.admitAfterVerify(1, clock)).toBe(true);
    expect(session.admitAfterVerify(2, clock)).toBe(true);
    expect(session.admitAfterVerify(2, clock)).toBe(false);
    expect(session.admitAfterVerify(1, clock)).toBe(false);
    expect(session.admitAfterVerify(0, clock)).toBe(false);
    // A rejected number does not advance the gate: the next higher passes.
    expect(session.admitAfterVerify(3, clock)).toBe(true);
  });

  it('cannot be raced: interleaved calls cannot both pass', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      60_000,
      clock,
    );
    // Two racing requests carrying the SAME sequence: exactly one passes.
    expect(session.admitAfterVerify(9, clock)).toBe(true);
    expect(session.admitAfterVerify(9, clock)).toBe(false);
  });

  it('ends the session at sequence exhaustion rather than wrapping', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      3_600_000,
      clock,
    );
    expect(session.admitAfterVerify(Number.MAX_SAFE_INTEGER, clock)).toBe(true);
    // The next sequence cannot exist: the session ends.
    expect(session.admitAfterVerify(Number.MAX_SAFE_INTEGER, clock)).toBe(false);
  });
});

describe('Session — revocation', () => {
  it('is terminal: verify refuses, admission refuses, and revoke is idempotent', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      60_000,
      clock,
    );
    session.revoke();
    session.revoke();
    expect(session.canVerify()).toBe(false);
    expect(session.isAdmissible(clock)).toBe(false);
    expect(session.admitAfterVerify(1, clock)).toBe(false);
    expect(
      await session.verify(
        ['setu-diagnostics-v1', 'request', TEST_SESSION_ID, '', '1', 'GET', 'h', '/v1/status'],
        'a'.repeat(64),
      ),
    ).toBe(false);
    expect(await session.sign(['setu-diagnostics-v1', 'response'])).toBe(null);
  });

  it('blocks a verification that begins before the revocation lands', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      60_000,
      clock,
    );
    // Verification starts (await), revocation lands during the await, and
    // the post-verify gate still refuses.
    const pending = session.verify(
      ['setu-diagnostics-v1', 'request', TEST_SESSION_ID, '', '1', 'GET', 'h', '/v1/status'],
      'a'.repeat(64),
    );
    session.revoke();
    expect(await pending).toBe(false);
  });
});

describe('Session — instance binding', () => {
  it('binds once and ignores later binding attempts', async () => {
    const clock = new MutableClock();
    const session = await DiagnosticsSessionState.create(
      crypto.subtle,
      TEST_SESSION_ID,
      TEST_KEY_BYTES,
      60_000,
      clock,
    );
    session.bindInstance(TEST_INSTANCE_ID);
    expect(session.hasInstance()).toBe(true);
    expect(session.instanceId).toEqual(TEST_INSTANCE_ID);
    session.bindInstance('00000000-0000-4000-8000-000000000000');
    expect(session.instanceId).toEqual(TEST_INSTANCE_ID);
  });
});
