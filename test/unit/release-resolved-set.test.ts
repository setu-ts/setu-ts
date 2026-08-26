import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createReleaseResolvedSet,
  serializeReleaseResolvedSet,
} from '../../scripts/release-resolved-set.ts';

describe('release resolved-set artifact', () => {
  it('preserves the complete lockfile under the release identity', () => {
    const lockfile = {
      version: '5',
      specifiers: { 'npm:zod@^4.4.0': '4.4.3' },
      npm: { 'zod@4.4.3': { integrity: 'sha512-example' } },
    };

    expect(createReleaseResolvedSet('0.1.0-alpha.10', lockfile)).toEqual({
      schemaVersion: 1,
      release: '0.1.0-alpha.10',
      lockfile,
    });
  });

  it('serializes the artifact as stable, newline-terminated JSON', () => {
    const serialized = serializeReleaseResolvedSet(
      createReleaseResolvedSet('1.0.0', { version: '5', specifiers: {} }),
    );

    expect(serialized).toBe(
      '{\n' +
        '  "schemaVersion": 1,\n' +
        '  "release": "1.0.0",\n' +
        '  "lockfile": {\n' +
        '    "version": "5",\n' +
        '    "specifiers": {}\n' +
        '  }\n' +
        '}\n',
    );
  });

  it('rejects an empty release or lockfile version', () => {
    expect(() => createReleaseResolvedSet('', { version: '5', specifiers: {} })).toThrow(TypeError);
    expect(() => createReleaseResolvedSet('1.0.0', { version: '', specifiers: {} })).toThrow(
      TypeError,
    );
  });
});
