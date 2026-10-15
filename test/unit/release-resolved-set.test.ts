import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  createReleaseResolvedSet,
  serializeReleaseResolvedSet,
  type IPnpmLockfile,
} from '../../scripts/release-resolved-set.ts';

describe('pnpm release resolved set', () => {
  it('sorts packages, preserves integrity and excludes importer/snapshot implementation details', () => {
    const lock = parse(
      "lockfileVersion: '9.0'\npackages:\n  zod@4.4.3:\n    resolution: {integrity: sha512-example}\n  '@scope/a@1.0.0':\n    resolution: {tarball: https://example.test/a.tgz}\nsnapshots: {}\n",
    ) as IPnpmLockfile;
    const result = createReleaseResolvedSet('0.9.0', lock);
    expect(result).toEqual({
      version: '0.9.0',
      lockfileVersion: '9.0',
      packages: { '@scope/a@1.0.0': {}, 'zod@4.4.3': { integrity: 'sha512-example' } },
    });
    expect(Object.keys(result.packages)).toEqual(['@scope/a@1.0.0', 'zod@4.4.3']);
    expect(serializeReleaseResolvedSet(result)).toBe(JSON.stringify(result, null, 2) + '\n');
  });
  it('supports a lock with no packages and refuses empty identities', () => {
    expect(createReleaseResolvedSet('1.0.0', { lockfileVersion: '9.0' }).packages).toEqual({});
    expect(() => createReleaseResolvedSet('', { lockfileVersion: '9.0' })).toThrow(TypeError);
    expect(() => createReleaseResolvedSet('1.0.0', { lockfileVersion: '' })).toThrow(TypeError);
  });
});
