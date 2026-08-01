/**
 * Unit tests for outlier ejection.
 *
 * Every case runs on the fake monotonic clock, so windows and expiries are
 * exact rather than timing-dependent.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { EjectionTracker } from '../../src/services/ejection-tracker.ts';
import { createFakeRuntime, type FakeRuntime, instance } from '../fixtures/fakes.ts';

const DEFAULTS = {
  failureThreshold: 3,
  windowMs: 1_000,
  durationMs: 5_000,
  maxEjectionPercent: 100,
};

function setup(
  overrides: Partial<typeof DEFAULTS> = {},
): { tracker: EjectionTracker; runtime: FakeRuntime } {
  const runtime = createFakeRuntime();
  return {
    tracker: new EjectionTracker(runtime, { ...DEFAULTS, ...overrides }),
    runtime,
  };
}

const a = instance({ id: 'a', host: '10.0.0.1' });
const b = instance({ id: 'b', host: '10.0.0.2' });
const c = instance({ id: 'c', host: '10.0.0.3' });

describe('EjectionTracker', () => {
  it('ejects once the threshold is reached inside the window', () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 2);
    }
    expect(tracker.filter('billing', [a, b]).map((i) => i.id)).toEqual(['b']);
    expect(tracker.ejectedCount).toBe(1);
  });

  it('does not eject when failures fall outside the rolling window', () => {
    const { tracker, runtime } = setup();
    tracker.record('billing', a, 'failure', 2);
    runtime.advance(600);
    tracker.record('billing', a, 'failure', 2);
    runtime.advance(600);
    // The first failure is now older than the 1000 ms window, so only two are
    // live and the threshold of three is never met.
    tracker.record('billing', a, 'failure', 2);
    expect(tracker.filter('billing', [a, b]).map((i) => i.id)).toEqual(['a', 'b']);
    expect(tracker.ejectedCount).toBe(0);
  });

  it('a success clears the window and un-ejects immediately', () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 2);
    }
    expect(tracker.ejectedCount).toBe(1);

    tracker.record('billing', a, 'success', 2);
    expect(tracker.ejectedCount).toBe(0);
    expect(tracker.filter('billing', [a, b]).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('the ejection expires after durationMs', () => {
    const { tracker, runtime } = setup();
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 2);
    }
    expect(tracker.filter('billing', [a, b]).map((i) => i.id)).toEqual(['b']);

    runtime.advance(5_001);
    expect(tracker.filter('billing', [a, b]).map((i) => i.id)).toEqual(['a', 'b']);
    expect(tracker.ejectedCount).toBe(0);
  });

  it('refuses an ejection that would exceed maxEjectionPercent', () => {
    const { tracker } = setup({ maxEjectionPercent: 50 });
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 3);
    }
    // 1 of 3 is 33%, allowed.
    expect(tracker.ejectedCount).toBe(1);

    for (let i = 0; i < 3; i++) {
      tracker.record('billing', b, 'failure', 3);
    }
    // A second would be 67%, over the 50% cap — so it does not happen.
    expect(tracker.ejectedCount).toBe(1);
    expect(tracker.filter('billing', [a, b, c]).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('caps per service rather than across all services', () => {
    const { tracker } = setup({ maxEjectionPercent: 50 });
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 2);
    }
    for (let i = 0; i < 3; i++) {
      tracker.record('orders', a, 'failure', 2);
    }
    // One in each service: 50% of each, both allowed.
    expect(tracker.ejectedCount).toBe(2);
  });

  it('allows the ejection when the known count is unknown', () => {
    const { tracker } = setup({ maxEjectionPercent: 50 });
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 0);
    }
    expect(tracker.ejectedCount).toBe(1);
  });

  it('does not re-eject an already-ejected instance', () => {
    const { tracker, runtime } = setup();
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 2);
    }
    runtime.advance(4_000);
    // A further failure while already ejected must not extend the ejection,
    // or a busy caller would keep an instance out forever.
    tracker.record('billing', a, 'failure', 2);
    runtime.advance(1_001);
    expect(tracker.ejectedCount).toBe(0);
  });

  it('returns the unfiltered list when every instance is ejected', () => {
    const { tracker } = setup();
    for (const target of [a, b]) {
      for (let i = 0; i < 3; i++) {
        tracker.record('billing', target, 'failure', 2);
      }
    }
    // Serving nothing would turn a correlated failure into a total outage.
    expect(tracker.filter('billing', [a, b]).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('keys on service name as well as instance id', () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 2);
    }
    // Same id, different service — untouched.
    const orders = instance({ id: 'a', serviceName: 'orders' });
    expect(tracker.filter('orders', [orders]).map((i) => i.id)).toEqual(['a']);
  });

  it('clear() drops all state', () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i++) {
      tracker.record('billing', a, 'failure', 2);
    }
    expect(tracker.ejectedCount).toBe(1);
    tracker.clear();
    expect(tracker.ejectedCount).toBe(0);
    expect(tracker.filter('billing', [a, b]).map((i) => i.id)).toEqual(['a', 'b']);
  });
});
