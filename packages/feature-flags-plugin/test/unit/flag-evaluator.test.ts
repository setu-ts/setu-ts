/**
 * Tests for `evaluateFlag` and `bucket` — pure evaluation seam.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { bucket, evaluateFlag, fnv1a32 } from '../../src/evaluation/flag-evaluator.ts';
import type { FlagDefinition } from '../../src/interfaces/index.ts';

describe('flag-evaluator', () => {
  describe('fnv1a32', () => {
    it('produces deterministic output for a given input', () => {
      const result1 = fnv1a32('test');
      const result2 = fnv1a32('test');
      expect(result1).toBe(result2);
    });

    it('returns different values for different inputs', () => {
      const result1 = fnv1a32('flag:user1');
      const result2 = fnv1a32('flag:user2');
      expect(result1).not.toBe(result2);
    });

    it('always returns an unsigned 32-bit integer', () => {
      const value = fnv1a32('anything');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    });

    // Pinned vector — FNV-1a 32-bit over UTF-8 bytes.
    // Reference: https://isthe.com/chongo/tech/comp/fnv/ (64-1.txt)
    it('fnv1a32("foobar") === 0xbf9cf968 (3214735720)', () => {
      expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    });

    it('fnv1a32("") === 0x811c9dc5 (empty-string offset basis)', () => {
      expect(fnv1a32('')).toBe(0x811c9dc5);
    });
  });

  describe('bucket', () => {
    it('returns a value in [0, 99]', () => {
      const value = bucket('test-flag', 'user1');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(100);
    });

    it('is stable across calls with the same (flag, userId)', () => {
      const v1 = bucket('my-flag', 'user-42');
      const v2 = bucket('my-flag', 'user-42');
      expect(v1).toBe(v2);
    });

    // Pinned bucket value — not circular against bucket() itself.
    // bucket("flag:user") = fnv1a32("flag:user") % 100 = 0x1dddc424 % 100 = 32
    it('bucket("flag", "user") === 32 (pinned)', () => {
      expect(bucket('flag', 'user')).toBe(32);
    });
  });

  describe('evaluateFlag', () => {
    it('unknown flag (def === undefined) → false', () => {
      expect(evaluateFlag('nonexistent', undefined, undefined)).toBe(false);
    });

    it('enabled:false alone → false', () => {
      const def: FlagDefinition = { enabled: false };
      expect(evaluateFlag('flag', def, undefined)).toBe(false);
    });

    it('enabled:true with no percentage/users → true', () => {
      const def: FlagDefinition = { enabled: true };
      expect(evaluateFlag('flag', def, undefined)).toBe(true);
    });

    // C5 semantics — the allowlist overrides enabled: false
    it('{ enabled: false, users: ["user1"] } with userId "user1" → true', () => {
      const def: FlagDefinition = { enabled: false, users: ['user1'] };
      expect(evaluateFlag('flag', def, { userId: 'user1' })).toBe(true);
    });

    it('{ enabled: false, users: ["user1"] } with userId "other" → false', () => {
      const def: FlagDefinition = { enabled: false, users: ['user1'] };
      expect(evaluateFlag('flag', def, { userId: 'other' })).toBe(false);
    });

    it('allowlist hit bypasses a set percentage', () => {
      const def: FlagDefinition = { enabled: false, users: ['user1'], percentage: 0 };
      expect(evaluateFlag('flag', def, { userId: 'user1' })).toBe(true);
    });

    // Percentage: >= 100
    it('percentage >= 100 → true', () => {
      const def: FlagDefinition = { enabled: true, percentage: 100 };
      expect(evaluateFlag('flag', def, { userId: 'any' })).toBe(true);
    });

    // Percentage: <= 0
    it('percentage <= 0 with userId → false', () => {
      const def: FlagDefinition = { enabled: true, percentage: 0 };
      expect(evaluateFlag('flag', def, { userId: 'any' })).toBe(false);
    });

    // Percentage: deterministic bucket
    it('userId whose bucket is below threshold → true', () => {
      // Find a user whose bucket is 0 (below any positive percentage)
      const def: FlagDefinition = { enabled: true, percentage: 50 };
      // We know from bucket() that fnv1a32 is deterministic; compute one we can assert
      // Use a hardcoded known-good pair: bucket("flag", "user")
      const b = bucket('flag', 'user');
      if (b < 50) {
        expect(evaluateFlag('flag', def, { userId: 'user' })).toBe(true);
      } else {
        // If this particular user hashes above 50, try another
        for (const testUser of ['aaa', 'bbb', 'ccc', 'ddd', 'eee']) {
          if (bucket('flag', testUser) < 50) {
            expect(evaluateFlag('flag', def, { userId: testUser })).toBe(true);
            break;
          }
        }
      }
    });

    it('userId whose bucket is above threshold → false', () => {
      const def: FlagDefinition = { enabled: true, percentage: 50 };
      // Find a user whose bucket >= 50
      for (const testUser of ['user', 'aaa', 'bbb', 'ccc', 'ddd', 'eee']) {
        const b = bucket('flag', testUser);
        if (b >= 50) {
          expect(evaluateFlag('flag', def, { userId: testUser })).toBe(false);
          break;
        }
      }
    });

    // No-userId partial rollout
    it('no userId with percentage → false', () => {
      const def: FlagDefinition = { enabled: true, percentage: 50 };
      expect(evaluateFlag('flag', def, undefined)).toBe(false);
    });

    it('same (flag, userId) always yields the same verdict', () => {
      const def: FlagDefinition = { enabled: true, percentage: 30 };
      const v1 = evaluateFlag('stable-flag', def, { userId: 'stable-user' });
      const v2 = evaluateFlag('stable-flag', def, { userId: 'stable-user' });
      const v3 = evaluateFlag('stable-flag', def, { userId: 'stable-user' });
      expect(v1).toBe(v2);
      expect(v2).toBe(v3);
    });

    // Attributes are accepted but not consumed by this evaluator
    it('context with attributes does not change the verdict', () => {
      const def: FlagDefinition = { enabled: true, percentage: 0 };
      const resultNoAttrs = evaluateFlag('flag', def, { userId: 'u1' });
      const resultWithAttrs = evaluateFlag('flag', def, {
        userId: 'u1',
        attributes: { tier: 'premium', country: 'US' },
      });
      expect(resultNoAttrs).toBe(resultWithAttrs);
    });
  });
});
