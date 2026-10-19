/**
 * A real `setu new --template rest` project converted with `setu adopt`.
 *
 * The three rows this drives are the ones a fixture cannot prove: the project
 * BOOTS and answers `/ready` from the probes the workspace records, the entry the
 * CLI actually wrote is the one the rewrite matches, and the dotenv pair ends up
 * where the member runs with the root copy gone.
 *
 * @module
 */
import { run as runProcess, tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import { bootAndProbe, unusedPort, useWorkspacePackages } from '../fixtures/generated-project.ts';
import { DISCOVERY_SPECIFIER, SERVICE_PORT_EXPORT } from '../../src/workspace/discovery-module.ts';
import { WORKSPACE_MANIFEST } from '../../src/workspace/manifest.ts';

const runtime = createNodeRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/** Boots the member and asks the recorded health path. */
const READY_PROBE = `import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();
const response = await app.fetch(new Request('http://localhost/ready'));
console.log('__PROBE_RESULT__' + JSON.stringify({ status: response.status }));
await app.stop();
`;

describe('setu adopt on a real scaffold', () => {
  let root: string;
  const out: string[] = [];
  const err: string[] = [];

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });

  beforeEach(async () => {
    root = await tempDir({ prefix: 'setu-adopt-e2e-' });
    out.length = 0;
    err.length = 0;
  });

  afterEach(async () => {
    await nodeFs.rm(root, { recursive: true });
  });

  it('serves /ready, binds the allocated port, and keeps the dotenv pair with the member', async () => {
    const port = await unusedPort();
    expect(await run(['new', 'svc', '--template', 'rest', '--runtime', 'deno'])).toBe(0);

    const project = `${root}/svc`;
    // The scaffold emits the pair this conversion has to move.
    expect(await nodeFs.readFile(`${project}/.env`, 'utf8')).toContain('Local configuration.');

    expect(await run(['adopt', '--dir', project, '--port', String(port)])).toBe(0);
    expect(err.join('\n')).toBe('');

    const member = `${project}/apps/svc`;
    // The entry the CLI rendered is the one the rewrite matches — no hand edit.
    const main = await nodeFs.readFile(`${member}/main.ts`, 'utf8');
    expect(main).toContain(`import { ${SERVICE_PORT_EXPORT} } from '${DISCOVERY_SPECIFIER}';`);
    expect(main).toContain(`await app.start({ port: ${SERVICE_PORT_EXPORT} });`);
    expect(out.join('\n')).not.toContain('port yourself');

    // The dotenv pair moved with the member; nothing is left at the root.
    expect(await nodeFs.readFile(`${member}/.env`, 'utf8')).toContain('Local configuration.');
    expect(await nodeFs.readFile(`${member}/.env.example`, 'utf8')).toContain('Copy this file');
    await expect(nodeFs.readFile(`${project}/.env`, 'utf8')).rejects.toThrow();

    // The manifest records what the dependencies declare, and the probes follow it.
    const manifest = JSON.parse(
      await nodeFs.readFile(`${project}/${WORKSPACE_MANIFEST}`, 'utf8'),
    ) as { members: { healthProbes?: boolean; metricsEndpoint?: boolean }[] };
    expect(manifest.members[0]).toMatchObject({ healthProbes: true, metricsEndpoint: true });
    const k8s = await nodeFs.readFile(`${project}/k8s/members.yaml`, 'utf8');
    expect(k8s).toMatch(/readinessProbe:\n\s+httpGet:\n\s+path: \/ready/);

    // The generated root ignore rules cover the moved file, checked by git itself.
    expect((await runProcess('git', { args: ['init', '-q'], cwd: project })).code).toBe(0);
    expect(
      (
        await runProcess('git', {
          args: ['check-ignore', `apps/svc/.env`],
          cwd: project,
        })
      ).code,
    ).toBe(0);

    await useWorkspacePackages(member);
    const result = (await bootAndProbe(member, READY_PROBE)) as { status?: number };
    expect(result.status).toBe(200);
  });
});
