/**
 * `describeThrown`'s last-resort fallback (M119g, V10-63): if the shared
 * renderer ever throws, the log line still gets a `typeof` description rather
 * than replacing the failure it describes.
 *
 * The shared renderer is total today, so the fallback is reachable only by
 * making it throw — which is exactly the regression this file guards. Kept
 * separate because mocking `@setu-ts/common` for the whole module would defeat
 * the real-renderer assertions in `safe-log.test.ts`.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';

import { describeThrown } from '../../src/core/safe-log.ts';

vi.mock('@setu-ts/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@setu-ts/common')>();
  return {
    ...actual,
    describeError: (): string => {
      throw new Error('renderer failed');
    },
  };
});

describe('describeThrown fallback', () => {
  it('falls back to typeof when the shared renderer throws', () => {
    expect(describeThrown('boom')).toBe('string');
    expect(describeThrown(Object.create(null))).toBe('object');
  });
});
