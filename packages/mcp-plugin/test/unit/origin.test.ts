import { it, expect } from 'vitest';
import { originAllowed } from '../../src/serve/origin.ts';
it.each([
  [null, true],
  ['https://app.test', false],
  ['https://client.test', true],
  ['https://evil.test', false],
  ['null', false],
  ['bad', false],
])('checks origin %s', (origin, expected) => {
  expect(originAllowed(origin as string | null, ['https://client.test'])).toBe(expected);
});
it('requires an explicit listing even for a same-origin browser UI', () => {
  expect(originAllowed('https://app.test', [])).toBe(false);
  expect(originAllowed('https://app.test', ['https://app.test'])).toBe(true);
});
