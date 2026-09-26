/**
 * Unit tests for the provenance options surface (M98e): the compiled policy
 * every consumer reads is validated ONCE, at the earliest call of
 * `loadConfig` or `ConfigPlugin(...)`, with fixed messages that never echo a
 * supplied value.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ConfigDiagnosticsOptions } from '../../src/options.ts';
import {
  compileConfigDiagnosticsPolicy,
  CONFIG_DIAGNOSTICS_ERRORS,
} from '../../src/diagnostics/provenance.ts';

describe('ConfigDiagnosticsOptions | compilation', () => {
  it('compiles the key and file alias maps', () => {
    const policy = compileConfigDiagnosticsPolicy({
      enabled: true,
      keys: { PORT: 'port', HOST: 'host' },
      files: { '.env.local': 'dotenv-local', '.env': 'dotenv' },
    });
    expect([...policy.aliasByKey]).toEqual([['PORT', 'port'], ['HOST', 'host']]);
    expect([...policy.aliasByPath]).toEqual([['.env.local', 'dotenv-local'], ['.env', 'dotenv']]);
  });

  it('compiles with no files map at all', () => {
    const policy = compileConfigDiagnosticsPolicy({ enabled: true, keys: { PORT: 'port' } });
    expect(policy.aliasByPath.size).toEqual(0);
  });

  it('refuses a non-object or a disabled flag with fixed messages', () => {
    expect(() => compileConfigDiagnosticsPolicy(null as unknown as ConfigDiagnosticsOptions))
      .toThrow(CONFIG_DIAGNOSTICS_ERRORS.badOptions);
    expect(() =>
      compileConfigDiagnosticsPolicy({
        enabled: false,
        keys: {},
      } as unknown as ConfigDiagnosticsOptions)
    ).toThrow(CONFIG_DIAGNOSTICS_ERRORS.notEnabled);
    expect(() =>
      compileConfigDiagnosticsPolicy({
        enabled: true,
        keys: 'nope',
      } as unknown as ConfigDiagnosticsOptions)
    ).toThrow(CONFIG_DIAGNOSTICS_ERRORS.badKeys);
  });

  it('refuses more than 128 keys and more than eight files', () => {
    const keys = Object.fromEntries(
      Array.from({ length: 129 }, (_, i) => [`K${i}`, `k${i}`]),
    );
    expect(() => compileConfigDiagnosticsPolicy({ enabled: true, keys })).toThrow(
      CONFIG_DIAGNOSTICS_ERRORS.tooManyKeys,
    );
    const files = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`.env${i}`, `f${i}`]));
    expect(() => compileConfigDiagnosticsPolicy({ enabled: true, keys: {}, files })).toThrow(
      CONFIG_DIAGNOSTICS_ERRORS.tooManyFiles,
    );
  });

  it('refuses an empty, oversized, or control-character alias without echoing it', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ KEY: '' }, CONFIG_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ KEY: 'x'.repeat(65) }, CONFIG_DIAGNOSTICS_ERRORS.aliasBytes],
      [{ KEY: 'bad\nalias' }, CONFIG_DIAGNOSTICS_ERRORS.aliasControl],
    ];
    for (const [keys, expected] of cases) {
      try {
        compileConfigDiagnosticsPolicy({ enabled: true, keys });
        throw new Error('expected a RangeError');
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        expect((error as RangeError).message).toEqual(expected);
        // Value-free refusal: the supplied alias never appears.
        expect((error as RangeError).message).not.toContain('x'.repeat(65));
      }
    }
  });

  it('refuses duplicate aliases within each map', () => {
    expect(() => compileConfigDiagnosticsPolicy({ enabled: true, keys: { A: 'same', B: 'same' } }))
      .toThrow(CONFIG_DIAGNOSTICS_ERRORS.duplicateAlias);
    expect(() =>
      compileConfigDiagnosticsPolicy({
        enabled: true,
        keys: { A: 'a' },
        files: { '.env.local': 'same', '.env': 'same' },
      })
    ).toThrow(CONFIG_DIAGNOSTICS_ERRORS.duplicateAlias);
  });

  it('refuses a non-string alias', () => {
    expect(() =>
      compileConfigDiagnosticsPolicy({
        enabled: true,
        keys: { KEY: 42 } as unknown as Record<string, string>,
      })
    ).toThrow(CONFIG_DIAGNOSTICS_ERRORS.badKeys);
    expect(() =>
      compileConfigDiagnosticsPolicy({
        enabled: true,
        keys: {},
        files: { '.env': true } as unknown as Record<string, string>,
      })
    ).toThrow(CONFIG_DIAGNOSTICS_ERRORS.badFiles);
  });
});
