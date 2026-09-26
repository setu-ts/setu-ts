/**
 * Unit tests for the environment loader (M98e provenance seam): the exact
 * env/file precedence, approved path aliasing, and the load's provenance
 * observations — all observed through the ONE merge implementation,
 * `loadEnvWithProvenance`, which plain `loadEnv` delegates to and discards.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { loadEnv, loadEnvWithProvenance } from '../../src/services/env-loader.ts';
import { createFakeFileSystem, createRuntime } from '../fixtures/fake-runtime.ts';

const FILES = {
  '.env': 'PORT=1000\nHOST=base-host\nONLY_FILE=from-base\n',
  '.env.local': 'PORT=2000\nHOST=local-host\n',
};

/** A runtime over the standard two-file fixture and a small environment. */
function runtime(env: Record<string, string | undefined> = { PORT: '3000' }) {
  return createRuntime({ env, fs: createFakeFileSystem(FILES) });
}

describe('loadEnvWithProvenance | precedence evidence', () => {
  it('records the runtime environment winning over every file, with the displaced aliases', async () => {
    const { values, sources } = await loadEnvWithProvenance(runtime(), {
      envFilePath: ['.env.local', '.env'],
    }, {
      approvedKeys: new Set(['PORT', 'ONLY_FILE']),
      aliasByPath: new Map([['.env.local', 'dotenv-local'], ['.env', 'dotenv']]),
    });
    expect(values['PORT']).toEqual('3000');
    // Displacement order, lowest precedence first: `.env` was displaced
    // before `.env.local`.
    expect(sources.get('PORT')).toEqual({
      origin: 'environment',
      overriddenSourceAliases: ['dotenv', 'dotenv-local'],
    });
  });

  it('records file-over-file displacement, lowest precedence first', async () => {
    const { values, sources } = await loadEnvWithProvenance(runtime({}), {
      envFilePath: ['.env.local', '.env'],
    }, {
      approvedKeys: new Set(['PORT', 'ONLY_FILE']),
      aliasByPath: new Map([['.env.local', 'dotenv-local'], ['.env', 'dotenv']]),
    });
    expect(values['PORT']).toEqual('2000');
    expect(sources.get('PORT')).toEqual({
      origin: 'file',
      sourceAlias: 'dotenv-local',
      overriddenSourceAliases: ['dotenv'],
    });
    // `.env` is the last file to write, so ONLY_FILE keeps its alias.
    expect(sources.get('ONLY_FILE')).toEqual({
      origin: 'file',
      sourceAlias: 'dotenv',
      overriddenSourceAliases: [],
    });
  });

  it('reduces an unapproved path to the category, never naming it', async () => {
    const { sources } = await loadEnvWithProvenance(runtime({}), {
      envFilePath: ['.env.local'],
    }, {
      // `.env.local` was NOT approved.
      approvedKeys: new Set(['PORT']),
      aliasByPath: new Map(),
    });
    expect(sources.get('PORT')).toEqual({
      origin: 'file',
      overriddenSourceAliases: [],
    });
    expect(JSON.stringify([...sources.values()])).not.toContain('.env.local');
  });

  it('records an environment-only key with no displacement', async () => {
    const { sources } = await loadEnvWithProvenance(runtime({ FRESH: 'yes' }), {}, {
      approvedKeys: new Set(['FRESH']),
      aliasByPath: new Map(),
    });
    expect(sources.get('FRESH')).toEqual({ origin: 'environment', overriddenSourceAliases: [] });
  });

  it('observes ONLY approved keys — unapproved env and file keys are never recorded', async () => {
    const { values, sources } = await loadEnvWithProvenance(
      runtime({ PORT: '3000', UNAPPROVED_ENV: 'x' }),
      { envFilePath: ['.env.local', '.env'] },
      {
        approvedKeys: new Set(['PORT']),
        aliasByPath: new Map([['.env.local', 'dotenv-local'], ['.env', 'dotenv']]),
      },
    );
    // The merge itself is unchanged: every key still loads.
    expect(values['UNAPPROVED_ENV']).toEqual('x');
    expect(values['ONLY_FILE']).toBeDefined();
    // But only the approved key was observed, even transiently.
    expect([...sources.keys()]).toEqual(['PORT']);
  });
});

describe('loadEnv | delegation', () => {
  it('produces the identical merged values through the same implementation', async () => {
    const withProvenance = await loadEnvWithProvenance(runtime(), {
      envFilePath: ['.env.local', '.env'],
    });
    const plain = await loadEnv(runtime(), { envFilePath: ['.env.local', '.env'] });
    expect(plain).toEqual(withProvenance.values);
  });

  it('still throws when a configured file cannot be read', async () => {
    const failing = createRuntime({ env: {}, fs: createFakeFileSystem() });
    await expect(loadEnv(failing, { envFilePath: '.env' })).rejects.toThrow(
      /unable to read env file/,
    );
  });
});
