import { expect, it } from 'vitest';
import { RefreshBackoff } from '../../src/services/refresh-backoff.ts';

it('spaces each name by 1, 2, 4, 8, 16, 30, 30 seconds and resets on success', () => {
  let now = 0;
  const backoff = new RefreshBackoff(() => now);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    expect(backoff.ready('billing')).toBe(true);
    backoff.failed('billing');
    expect(backoff.ready('other')).toBe(true);
    now += delay - 1;
    expect(backoff.ready('billing')).toBe(false);
    now++;
  }
  backoff.reset('billing');
  backoff.failed('billing');
  now += 1000;
  expect(backoff.ready('billing')).toBe(true);
  backoff.failed('billing');
  backoff.clear();
  expect(backoff.ready('billing')).toBe(true);
});
