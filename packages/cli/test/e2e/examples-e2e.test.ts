import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';
import { VERSION } from '../../src/version.ts';
import { EXAMPLES } from '../../src/examples/catalog.ts';
import { npmInstall, npmRun, startOverlay } from '../fixtures/node-project.ts';
import type { RegistryOverlay } from '../fixtures/node-project.ts';

const root = resolve('.tmp/examples-e2e');
const repository = resolve('.');
const fs = createNodeRuntimeServices().fs!;
let overlay: RegistryOverlay;
beforeAll(async () => {
  // The overlay needs loopback; surface a denied bind as a hook failure instead of a timeout.
  await new Promise<void>((accept, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => probe.close((error) => (error ? reject(error) : accept())));
  });
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  overlay = await startOverlay();
}, 300_000);
afterAll(async () => {
  await overlay?.close();
  await rm(root, { recursive: true, force: true });
});

describe('standalone examples against packed framework packages', () => {
  for (const example of EXAMPLES)
    it(`${example}: installs, checks and runs its own smoke proof`, async (context) => {
      const errors: string[] = [];
      const urls: string[] = [];
      const code = await runCli(['new', example, '--example', example], {
        fs,
        cwd: root,
        now: () => 0,
        log: () => {},
        error: (message) => errors.push(message),
        fetch: async (input) => {
          const url = String(input);
          urls.push(url);
          const prefix = `https://raw.githubusercontent.com/setu-ts/setu-ts/v${VERSION}/`;
          expect(url.startsWith(prefix)).toBe(true);
          return new Response(await readFile(resolve(repository, url.slice(prefix.length))));
        },
      });
      expect(code, errors.join('\n')).toBe(0);
      expect(urls.length).toBeGreaterThan(0);
      const project = `${root}/${example}`;
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      const checked = await npmRun(project, 'check');
      expect(checked.code, checked.output).toBe(0);
      const smoke = await npmRun(project, 'smoke');
      if (smoke.code === 77) {
        expect(['realtime', 'microservices']).toContain(example);
        context.skip(smoke.output);
      }
      expect(smoke.code, smoke.output).toBe(0);
    }, 240_000);
});
