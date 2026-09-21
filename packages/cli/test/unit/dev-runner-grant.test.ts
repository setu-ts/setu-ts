import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { workspaceDevRunner } from '../../src/workspace/dev-runner.ts';
import {
  DEVTOOL_ENV_NAMES,
  LEGACY_DENO_RUN_ALL,
  workspaceProfile,
} from '../../src/workspace/runtime-profile.ts';

describe('the root dev task grant', () => {
  it('carries --allow-env scoped to exactly the three devtool names', () => {
    const runAll = workspaceProfile('deno').runAll;
    const scoped = runAll.match(/--allow-env=([^\s]+)/);
    expect(scoped, 'the dev task must carry a scoped --allow-env').not.toBeNull();
    expect(scoped?.[1]?.split(',')).toEqual([...DEVTOOL_ENV_NAMES]);
  });

  it('names the exact contract the runner and the dev entry read', () => {
    expect(DEVTOOL_ENV_NAMES).toEqual([
      'SETU_DEVTOOL_SESSION_ID',
      'SETU_DEVTOOL_SESSION_KEY',
      'SETU_DEVTOOL_MEMBER',
    ]);
  });

  it('keeps --allow-net byte-identical to today — unscoped, never narrowed', () => {
    // A scoped allowlist governs OUTBOUND as well as bind on Deno 2.9.6, so
    // narrowing would refuse every database, broker and outbound call the
    // application makes. The loopback guarantee is the listener's.
    expect(workspaceProfile('deno').runAll).toContain('--allow-read --allow-run --allow-net ');
    expect(workspaceProfile('deno').runAll).not.toContain('--allow-net=');
  });

  it('recognizes the pre-M98c grant so enable can widen it and nothing else', () => {
    expect(LEGACY_DENO_RUN_ALL).toBe(
      'deno run --allow-read --allow-run --allow-net scripts/dev.ts',
    );
    expect(workspaceProfile('deno').runAll).not.toBe(LEGACY_DENO_RUN_ALL);
  });

  it('leaves the Node and Bun runners untouched — the devtool is Deno-only', () => {
    expect(workspaceProfile('node').runAll).toBe('node scripts/dev.mjs');
    expect(workspaceProfile('bun').runAll).toBe('bun scripts/dev.mjs');
    expect(workspaceProfile('node').runAll).not.toContain('--allow-env');
  });

  it('emitted Deno runner reads all three names and forwards them per child', () => {
    const runner = workspaceDevRunner(workspaceProfile('deno')).contents;
    for (const name of DEVTOOL_ENV_NAMES) {
      expect(runner).toContain(`Deno.env.get('${name}')`);
    }
    // Explicit env for EVERY child: Deno.Command merges `env` into the
    // inherited one, so blanks are what stop siblings inheriting the pair.
    expect(runner).toContain("SETU_DEVTOOL_SESSION_ID: selected ? (devtoolSessionId ?? '') : ''");
    expect(runner).toContain("args: ['task', entryTask(member)],");
  });
});
