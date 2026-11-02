import { it, expect } from 'vitest';
import { originAllowed } from '../../src/serve/origin.ts';
it.each([
  [null, true],
  ['https://app.test', true],
  ['https://client.test', true],
  ['https://evil.test', false],
  ['null', false],
  ['bad', false],
])('checks origin %s', (origin, expected) => {
  expect(
    originAllowed('https://app.test/mcp', origin as string | null, ['https://client.test']),
  ).toBe(expected);
});
