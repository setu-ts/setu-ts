import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { CLIENT_RANGES } from '../../src/templates/client-dependencies.ts';
import { npmInstall, runIn, startOverlay } from '../fixtures/node-project.ts';

const npmAvailable = spawnSync('npm', ['--version']).status === 0;
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await nodeFs.rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('setu add workspace peers through the packed registry overlay (M119f)', () => {
  it.skipIf(!npmAvailable)(
    'loads every console peer from the root-hoisted telemetry plugin despite a conflicting member',
    async () => {
      root = await tempDir({ prefix: 'setu-workspace-peers-' });
      const output: string[] = [];
      const cli = (args: readonly string[]) =>
        runCli(args, {
          fs: createNodeRuntimeServices().fs!,
          cwd: root!,
          now: () => 0,
          log: (message) => output.push(message),
          error: (message) => output.push(message),
        });
      expect(await cli(['new', 'ws', '--workspace', '--runtime', 'node']), output.join('\n')).toBe(
        0,
      );
      const project = `${root}/ws`;
      for (const member of ['api', 'conflict']) {
        expect(await cli(['g', 'app', member, '--dir', project]), output.join('\n')).toBe(0);
      }
      const conflictPath = `${project}/apps/conflict/package.json`;
      const conflict = JSON.parse(await nodeFs.readFile(conflictPath, 'utf8')) as {
        dependencies: Record<string, string>;
      };
      conflict.dependencies['@opentelemetry/api'] = '1.10.0';
      await nodeFs.writeFile(conflictPath, JSON.stringify(conflict));
      expect(
        await cli(['add', 'telemetry', '--dir', `${project}/apps/api`]),
        output.join('\n'),
      ).toBe(0);

      const peers = [
        '@opentelemetry/api',
        '@opentelemetry/context-async-hooks',
        '@opentelemetry/resources',
        '@opentelemetry/sdk-trace-base',
      ];
      for (const path of [`${project}/package.json`, `${project}/apps/api/package.json`]) {
        const manifest = JSON.parse(await nodeFs.readFile(path, 'utf8')) as {
          dependencies: Record<string, string>;
        };
        for (const peer of peers)
          expect(manifest.dependencies[peer], path).toBe(CLIENT_RANGES[peer]);
        expect(output.join('\n')).toContain(`updated ${path}`);
      }

      const overlay = await startOverlay();
      try {
        const installed = await npmInstall(project, overlay);
        expect(installed.code, installed.output).toBe(0);
        const plugin = `${project}/node_modules/@setu-ts/telemetry-plugin`;
        expect(await nodeFs.realpath(plugin)).toBe(plugin);
        // Run real ESM imports from the plugin's directory, the same resolution
        // origin as its guarded loaders. No application resolver or source hook.
        const probe = `${plugin}/peer-probe.mjs`;
        await nodeFs.writeFile(
          probe,
          `
        const peers = ${JSON.stringify(peers)};
        const resolved = [];
        for (const peer of peers) {
          await import(peer);
          resolved.push({ peer, url: import.meta.resolve(peer) });
        }
        console.log(JSON.stringify(resolved));
      `,
        );
        const loaded = await runIn(project, 'node', [probe]);
        expect(loaded.code, loaded.output).toBe(0);
        const resolved = JSON.parse(loaded.output) as { peer: string; url: string }[];
        expect(resolved.map((entry) => entry.peer)).toEqual(peers);
        for (const entry of resolved) {
          expect(entry.url).toContain(`${project}/node_modules/${entry.peer}/`);
        }
        const lock = JSON.parse(await nodeFs.readFile(`${project}/package-lock.json`, 'utf8')) as {
          packages: Record<string, { version?: string }>;
        };
        for (const peer of peers) {
          const copies = Object.keys(lock.packages).filter((path) =>
            path.endsWith(`node_modules/${peer}`),
          );
          expect(copies.filter((path) => path === `node_modules/${peer}`)).toHaveLength(1);
          // Only the deliberately incompatible API stays nested; no redundant
          // copies of the console SDK peers are needed in either member.
          expect(copies).toHaveLength(peer === '@opentelemetry/api' ? 2 : 1);
        }
        expect(lock.packages['apps/conflict/node_modules/@opentelemetry/api']?.version).toBe(
          '1.10.0',
        );
        expect(lock.packages['node_modules/@opentelemetry/api']?.version).toMatch(/^1\.9\./);
      } finally {
        await overlay.close();
      }
    },
    180_000,
  );
});
