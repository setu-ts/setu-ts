import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  crossClearInterval,
  crossClearTimeout,
  crossHrtime,
  crossNow,
  crossRandomBytes,
  crossSetInterval,
  crossSetTimeout,
  crossSubtle,
  crossUuid,
} from '../../src/services/cross-runtime.ts';

describe('cross-runtime services', () => {
  describe('crossUuid', () => {
    it('returns a valid UUID v4 string', () => {
      const uuid = crossUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('generates unique values', () => {
      const uuids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        uuids.add(crossUuid());
      }
      expect(uuids.size).toBe(100);
    });
  });

  describe('crossRandomBytes', () => {
    it('returns the requested number of bytes', () => {
      const bytes = crossRandomBytes(32);
      expect(bytes.length).toBe(32);
    });

    it('returns zero-length array for length 0', () => {
      const bytes = crossRandomBytes(0);
      expect(bytes.length).toBe(0);
    });

    it('produces different values on subsequent calls', () => {
      const a = crossRandomBytes(16);
      const b = crossRandomBytes(16);
      expect(Array.from(a)).not.toEqual(Array.from(b));
    });
  });

  describe('crossSubtle', () => {
    it('is a SubtleCrypto instance', () => {
      expect(crossSubtle).toBeDefined();
      expect(typeof crossSubtle.digest).toBe('function');
    });
  });

  describe('crossNow', () => {
    it('returns a positive number', () => {
      expect(crossNow()).toBeGreaterThan(0);
    });

    it('returns a value close to Date.now()', () => {
      const before = Date.now();
      const result = crossNow();
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });
  });

  describe('crossHrtime', () => {
    it('returns a positive number', () => {
      expect(crossHrtime()).toBeGreaterThanOrEqual(0);
    });

    it('is monotonic-ish (later values >= earlier)', async () => {
      const first = crossHrtime();
      // Small delay to ensure time advances
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 5));
      const second = crossHrtime();
      expect(second).toBeGreaterThanOrEqual(first);
    });
  });

  describe('timers', () => {
    it('setTimeout fires after the delay', async () => {
      let fired = false;
      const handle = crossSetTimeout(() => {
        fired = true;
      }, 10);
      expect(fired).toBe(false);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 30));
      expect(fired).toBe(true);
      // Cleanup not needed — already fired
      void handle;
    });

    it('clearTimeout cancels a pending timer', async () => {
      let fired = false;
      const handle = crossSetTimeout(() => {
        fired = true;
      }, 50);
      crossClearTimeout(handle);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 80));
      expect(fired).toBe(false);
    });

    it('setInterval fires repeatedly', async () => {
      let count = 0;
      const handle = crossSetInterval(() => {
        count++;
      }, 10);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 35));
      crossClearInterval(handle);
      expect(count).toBeGreaterThanOrEqual(2);
      // After clearing, no more fires
      const countAfter = count;
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 30));
      expect(count).toBe(countAfter);
    });

    it('clearInterval stops the interval', async () => {
      let count = 0;
      const handle = crossSetInterval(() => {
        count++;
      }, 10);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));
      crossClearInterval(handle);
      const countAfterClear = count;
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 40));
      expect(count).toBe(countAfterClear);
    });
  });
});
