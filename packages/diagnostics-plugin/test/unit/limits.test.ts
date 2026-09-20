/**
 * Unit tests for the bounds: the anonymous refusal budget, the per-session
 * bucket, the reserved authenticated slot, burst/refill behavior, hostile
 * traffic isolation, and the UTF-8 header budget.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CONNECTOR_LIMITS, ConnectorLimits } from '../../src/transport/limits.ts';
import { MutableClock, TEST_SESSION_ID } from '../fixtures/helpers.ts';

describe('Limits — anonymous refusal budget', () => {
  it('allows the burst of raw-validation refusals then refuses, and refills at the fixed rate', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    for (let i = 0; i < CONNECTOR_LIMITS.anonymousBurst; i++) {
      expect(limits.admitRawRefusal()).toBe(true);
    }
    // Budget exhausted: further raw refusals become rate-limited.
    expect(limits.admitRawRefusal()).toBe(false);
    // 5/s refill: after 1000ms exactly five more are available.
    clock.advance(1000);
    for (let i = 0; i < CONNECTOR_LIMITS.anonymousRatePerSecond; i++) {
      expect(limits.admitRawRefusal()).toBe(true);
    }
    expect(limits.admitRawRefusal()).toBe(false);
  });

  it('caps burst refill at the burst size', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    clock.advance(100_000); // an enormous idle period
    // Still only `burst` admissions, not burst + refill.
    for (let i = 0; i < CONNECTOR_LIMITS.anonymousBurst; i++) {
      expect(limits.admitRawRefusal()).toBe(true);
    }
    expect(limits.admitRawRefusal()).toBe(false);
  });

  it('never debits any session bucket', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    for (let i = 0; i < CONNECTOR_LIMITS.anonymousBurst; i++) {
      limits.admitRawRefusal();
    }
    // The session bucket is untouched by refusals: the paired client still
    // gets its full burst.
    clock.advance(0);
    expect(limits.beginHandler(true)).toBe(true);
    expect(limits.beginVerify()).toBe(true);
    expect(limits.promote(TEST_SESSION_ID)).toBe(true);
    limits.release(true);
  });
});

describe('Limits — concurrency lanes', () => {
  it('caps the pre-auth lanes at seven of the eight slots', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    const held: boolean[] = [];
    for (let i = 0; i < CONNECTOR_LIMITS.preAuthConcurrency; i++) {
      held.push(limits.beginHandler(false));
    }
    expect(held.every(Boolean)).toBe(true);
    // The 9th unpaired handler slot cannot be taken from the lanes...
    expect(limits.beginHandler(false)).toBe(false);
    // ...but the PAIRED client still admits into the eighth slot.
    expect(limits.beginHandler(true)).toBe(true);
    limits.release(true);
    // ...and every held slot is released exactly once each.
    for (let i = 0; i < held.length; i++) {
      limits.release(false);
    }
    expect(() => limits.release(false)).toThrow();
  });

  it('gives the verify lane its own cap', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    for (let i = 0; i < CONNECTOR_LIMITS.verifyingConcurrency; i++) {
      expect(limits.beginVerify()).toBe(true);
    }
    expect(limits.beginVerify()).toBe(false);
    for (let i = 0; i < CONNECTOR_LIMITS.verifyingConcurrency; i++) {
      limits.endVerify();
    }
    expect(limits.beginVerify()).toBe(true);
    limits.endVerify();
  });

  it('promotion frees a pre-auth slot and keeps the total slot', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    expect(limits.beginHandler(true)).toBe(true);
    expect(limits.beginVerify()).toBe(true);
    expect(limits.promote(TEST_SESSION_ID)).toBe(true);
    // The total slot is still held; an unpaired request can still enter.
    expect(limits.beginHandler(false)).toBe(true);
    limits.release(false);
    limits.release(true);
  });
});

describe('Limits — session bucket', () => {
  it('debits only on promotion, at the fixed rate, exhausted by burst', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    // Full-burst promotions with no elapsed time: the session bucket
    // empties after exactly `sessionBurst` promotions.
    for (let i = 0; i < CONNECTOR_LIMITS.sessionBurst; i++) {
      expect(limits.beginHandler(true)).toBe(true);
      expect(limits.beginVerify()).toBe(true);
      expect(limits.promote(TEST_SESSION_ID)).toBe(true);
      limits.release(true);
    }
    // One more promotion is refused — the session budget is spent, even
    // though the concurrency lanes are free.
    expect(limits.beginHandler(true)).toBe(true);
    expect(limits.beginVerify()).toBe(true);
    expect(limits.promote(TEST_SESSION_ID)).toBe(false);
    limits.endVerify();
    limits.release(true);
    // The refill is 20/s: after a full second exactly twenty more pass.
    clock.advance(1000);
    for (let i = 0; i < CONNECTOR_LIMITS.sessionRatePerSecond; i++) {
      expect(limits.beginHandler(true)).toBe(true);
      expect(limits.beginVerify()).toBe(true);
      expect(limits.promote(TEST_SESSION_ID)).toBe(true);
      limits.release(true);
    }
  });

  it('keeps separate buckets per session id', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    for (let i = 0; i < CONNECTOR_LIMITS.sessionBurst; i++) {
      expect(limits.beginHandler(true)).toBe(true);
      expect(limits.beginVerify()).toBe(true);
      expect(limits.promote('a'.repeat(32))).toBe(true);
      limits.release(true);
    }
    // A DIFFERENT session id has its own full bucket.
    expect(limits.beginHandler(true)).toBe(true);
    expect(limits.beginVerify()).toBe(true);
    expect(limits.promote('b'.repeat(32))).toBe(true);
    limits.release(true);
  });
});

describe('Limits — hostile flood', () => {
  it('a saturated hostile flood cannot take the reserved authenticated slot', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    // The flood's steady state: hostile handlers hold seven of the eight
    // slots in the pre-auth lanes.
    const held: boolean[] = [];
    for (let i = 0; i < CONNECTOR_LIMITS.preAuthConcurrency; i++) {
      held.push(limits.beginHandler(false));
    }
    expect(held.every(Boolean)).toBe(true);
    // The paired client arrives: the eighth slot is still available.
    expect(limits.beginHandler(true)).toBe(true);
    // It verifies, promotes, and completes — its slot accounting works.
    expect(limits.beginVerify()).toBe(true);
    expect(limits.promote(TEST_SESSION_ID)).toBe(true);
    limits.release(true);
    // The flood's own churn: raw-refusal budget drains to rate-limited, so
    // the flood cannot even buy unlimited refusals.
    let budgetExhausted = false;
    for (let i = 0; i < 50; i++) {
      if (!limits.admitRawRefusal()) {
        budgetExhausted = true;
        break;
      }
    }
    expect(budgetExhausted).toBe(true);
    // And the flood cannot grow past its seven lanes.
    expect(limits.beginHandler(false)).toBe(false);
    for (let i = 0; i < held.length; i++) {
      limits.release(false);
    }
  });
});

describe('Limits — header budget', () => {
  it('counts UTF-8 bytes of names and values against the 8 KiB budget', () => {
    const clock = new MutableClock();
    const limits = new ConnectorLimits(clock);
    const small = new Headers({ 'x-setu-session': 'a'.repeat(32) });
    expect(limits.headersWithinBudget(small)).toBe(true);

    // Multi-byte UTF-8: 2,048 'é' characters are 4,096 bytes, not 2,048.
    const wide = new Headers({ 'x-pad': 'é'.repeat(2_048) });
    expect(limits.headersWithinBudget(wide)).toBe(true);
    const tooWide = new Headers({
      'x-pad': 'é'.repeat(2_048),
      'x-pad-2': 'é'.repeat(2_048),
    });
    expect(limits.headersWithinBudget(tooWide)).toBe(false);

    const large = new Headers({ 'x-pad': 'a'.repeat(CONNECTOR_LIMITS.maxHeaderBytes) });
    expect(limits.headersWithinBudget(large)).toBe(false);
  });
});
