/**
 * Unit tests for the decidable half of the Node pack-and-boot gate
 * (M111a plan §3.10): the `workspace:` scan and the
 * skip-versus-fail decision.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  classifyLeg,
  decideOutcome,
  type LegResult,
  workspaceProtocolSpecifiers,
} from '../../scripts/node-build-gate.ts';

describe('workspaceProtocolSpecifiers', () => {
  it('names every shipped field still carrying workspace:', () => {
    const manifest = {
      dependencies: { '@setu-ts/common': 'workspace:^', hono: '^4' },
      peerDependencies: { '@setu-ts/kernel': 'workspace:*' },
      optionalDependencies: { '@setu-ts/x': 'workspace:~' },
    };
    expect(workspaceProtocolSpecifiers(manifest)).toEqual([
      'dependencies: @setu-ts/common@workspace:^',
      'peerDependencies: @setu-ts/kernel@workspace:*',
      'optionalDependencies: @setu-ts/x@workspace:~',
    ]);
  });

  it('ignores devDependencies, which npm never installs for a consumer', () => {
    expect(workspaceProtocolSpecifiers({ devDependencies: { a: 'workspace:^' } })).toEqual([]);
  });

  it('accepts the rewritten form pnpm pack produces', () => {
    expect(workspaceProtocolSpecifiers({ dependencies: { '@setu-ts/common': '^0.8.0' } })).toEqual(
      [],
    );
  });

  it('tolerates a non-object manifest and non-object or non-string fields', () => {
    expect(workspaceProtocolSpecifiers(null)).toEqual([]);
    expect(workspaceProtocolSpecifiers('x')).toEqual([]);
    expect(
      workspaceProtocolSpecifiers({ dependencies: 'nope', peerDependencies: { a: 1 } }),
    ).toEqual([]);
  });
});

describe('decideOutcome', () => {
  const passed: LegResult = { name: 'node 24', status: 'passed', detail: 'BOOT-OK {}' };
  const skipped: LegResult = { name: 'bun', status: 'skipped', detail: 'bun is not available' };
  const failed: LegResult = { name: 'node 22', status: 'failed', detail: 'exit 1' };

  it('passes when every leg passed', () => {
    const outcome = decideOutcome([passed], false);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.at(-1)).toBe('node-build passed: 1 leg(s).');
  });

  it('exits 77 on a skip — never 0 — and fails it under --require-all', () => {
    expect(decideOutcome([passed, skipped], false).code).toBe(77);
    const strict = decideOutcome([passed, skipped], true);
    expect(strict.code).toBe(1);
    expect(strict.lines.at(-1)).toContain('skipped under --require-all');
  });

  it('lets a failure win over a skip', () => {
    expect(decideOutcome([failed, skipped], false).code).toBe(1);
  });

  it('fails a run in which no leg ran', () => {
    expect(decideOutcome([], false)).toEqual({
      code: 1,
      lines: ['node-build FAILED: no leg ran.'],
    });
  });

  it('reports one line per leg', () => {
    expect(decideOutcome([passed, failed], false).lines.slice(0, 2)).toEqual([
      'passed  node 24: BOOT-OK {}',
      'failed  node 22: exit 1',
    ]);
  });
});

describe('classifyLeg', () => {
  it('passes only on exit 0 AND the boot line', () => {
    expect(classifyLeg('node 24', 0, 'noise\nBOOT-OK {"ok":true}\n')).toEqual({
      name: 'node 24',
      status: 'passed',
      detail: 'BOOT-OK {"ok":true}',
    });
  });

  it('fails an exit 0 that never reached its assertions', () => {
    expect(classifyLeg('bun', 0, 'started\n').status).toBe('failed');
  });

  it('fails a non-zero exit even with a boot line, reporting the tail', () => {
    const leg = classifyLeg('node 22', 1, 'BOOT-OK {}\nBOOT-FAILED /json answered 500');
    expect(leg.status).toBe('failed');
    expect(leg.detail).toBe('exit 1: BOOT-OK {} | BOOT-FAILED /json answered 500');
  });
});

describe('the CI job runs the gate strictly (M111a §3.10)', () => {
  /** The `node-build` job's block of `.github/workflows/ci.yml`. */
  async function nodeBuildJob(): Promise<string> {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
    const start = workflow.indexOf('\n  node-build:\n');
    expect(start).toBeGreaterThan(-1);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
  }

  it('passes --require-all, so a missing runtime fails instead of skipping', async () => {
    expect(await nodeBuildJob()).toContain('run: pnpm run check:node-build --require-all');
  });

  it('installs every runtime a leg needs, and drift-checks the manifests', async () => {
    const job = await nodeBuildJob();
    expect(job).toContain('uses: actions/setup-node@v4');
    expect(job).toContain('uses: oven-sh/setup-bun@v2');
    expect(job).toContain('run: corepack enable');
    // The manifest drift check runs under Node (M111e3); Deno is not set up in this job.
    expect(job).toMatch(/^ +run: node scripts\/node-manifests\.ts --check$/m);
    expect(job).not.toContain('setup-deno');
  });
});
