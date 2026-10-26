import { describe, expect, it, vi } from 'vitest';
import { EjectionTracker } from '../../src/services/ejection-tracker.ts';
import { createFakeRuntime, instance } from '../fixtures/fakes.ts';

describe('ejection state reclamation', () => {
  it('reclaims 10,000 vanished instances while preserving live ejections and recent windows', () => {
    const runtime = createFakeRuntime();
    const tracker = new EjectionTracker(runtime, {
      failureThreshold: 2,
      windowMs: 100,
      durationMs: 100_000,
      maxEjectionPercent: 100,
    });
    // Observe the actual storage, without exposing private state in the public API.
    const set = vi.spyOn(Map.prototype, 'set');
    let states: Map<unknown, unknown> | undefined;
    try {
      const pinned = instance({ id: 'pinned' });
      tracker.record('billing', pinned, 'failure', 0);
      states = set.mock.contexts.find(
        (map): map is Map<unknown, unknown> => map instanceof Map && map.has('billing\u0000pinned'),
      );
      tracker.record('billing', pinned, 'failure', 0);
      for (let i = 0; i < 10_000; i++) {
        runtime.advance(101);
        tracker.record('billing', instance({ id: `gone-${i}` }), 'failure', 0);
        if (i === 63) {
          expect(tracker.filter('billing', [pinned, instance({ id: 'healthy' })])).toHaveLength(1);
        }
      }
      expect(states).toBeDefined();
      expect(states?.size).toBeLessThan(128);
      expect(states?.has('billing\u0000pinned')).toBe(false);
      // A recent failure must survive a sweep and combine with the next one.
      const recent = instance({ id: 'recent' });
      tracker.record('billing', recent, 'failure', 0);
      for (let i = 0; i < 128; i++)
        tracker.record('billing', instance({ id: `live-${i}` }), 'failure', 0);
      tracker.record('billing', recent, 'failure', 0);
      expect(tracker.ejectedCount).toBe(1);
      tracker.clear();
      expect(states?.size).toBe(0);
    } finally {
      set.mockRestore();
    }
  });
});
