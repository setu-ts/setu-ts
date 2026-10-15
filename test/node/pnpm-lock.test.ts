/** The pnpm 12 lock stream is a package set across all documents. @module */
import { expect, it } from 'vitest';
import { parsePnpmLock } from '../../scripts/lib/pnpm-lock.ts';

it('merges every document, preserves integrity, and accepts identical duplicate packages', () => {
  const result = parsePnpmLock(`lockfileVersion: '9.0'
packages:
  pnpm@12.11.2: {resolution: {integrity: manager}}
---
lockfileVersion: '9.0'
packages:
  zod@4.4.3: {resolution: {integrity: project}}
  pnpm@12.11.2: {resolution: {integrity: manager}}
  archive@1.0.0: {resolution: {tarball: 'https://example.test/a'}}
`);
  expect(result).toEqual({
    lockfileVersion: '9.0',
    packages: {
      'pnpm@12.11.2': { resolution: { integrity: 'manager' } },
      'zod@4.4.3': { resolution: { integrity: 'project' } },
      'archive@1.0.0': { resolution: {} },
    },
  });
  expect(parsePnpmLock("lockfileVersion: '9.0'")).toEqual({ lockfileVersion: '9.0', packages: {} });
});

it.each([
  '',
  'null',
  'false',
  '{}',
  'lockfileVersion: 9',
  "lockfileVersion: ''",
  '[broken',
  "lockfileVersion: '9.0'\n---\nlockfileVersion: '10.0'",
  ...['null', 'false', '[]'].map((value) => `lockfileVersion: '9.0'\npackages: ${value}`),
  ...[
    'null',
    'false',
    '{}',
    '{resolution: null}',
    '{resolution: false}',
    '{resolution: {integrity: 1}}',
  ].map((value) => `lockfileVersion: '9.0'\npackages: {a@1.0.0: ${value}}`),
  "lockfileVersion: '9.0'\npackages: {a@1: {resolution: {integrity: before}}}\n---\nlockfileVersion: '9.0'\npackages: {a@1: {resolution: {integrity: after}}}",
])('refuses malformed, incompatible, or contradictory lock data: %s', (source) => {
  expect(() => parsePnpmLock(source)).toThrow();
});
