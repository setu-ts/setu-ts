import { spawnProcess, tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';

/**
 * The fixture runs as the published `setu` binary does: on Node, its TypeScript
 * loaded through `tsx`, with `@setu-ts/*` mapped to this workspace's sources.
 */
function spawnFixture(root: string, mode: 'handled' | 'unhandled' | 'prompt') {
  const tsx = createRequire(import.meta.url).resolve('tsx/esm');
  return spawnProcess(process.execPath, {
    args: [
      '--import',
      new URL('../../../../test/node-source-register.ts', import.meta.url).href,
      '--import',
      pathToFileURL(tsx).href,
      new URL('../fixtures/sigint-scaffold.ts', import.meta.url).pathname,
      root,
      mode,
    ],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  });
}

describe(
  'real SIGINT during scaffold writes',
  { skip: process.platform === 'win32' },
  () => {
    for (const mode of ['handled', 'unhandled'] as const) {
      it(`${mode} signal ${mode === 'handled' ? 'rolls back' : 'leaves partial files'}`, async () => {
        await nodeFs.mkdir('.tmp', { recursive: true });
        const root = await tempDir({
          dir: await nodeFs.realpath('.tmp'),
          prefix: 'sigint-',
        });
        const child = spawnFixture(root, mode);
        const stderr = new Response(child.stderr).text();
        const stdout = (async () => {
          let text = '';
          const decoder = new TextDecoder();
          for await (const chunk of child.stdout!) {
            text += decoder.decode(chunk, { stream: true });
            if (text.includes('WRITE17')) child.kill('SIGINT');
          }
          return text;
        })();
        const watchdog = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch { /* Already exited. */ }
        }, 10_000);
        try {
          const [text, errors, status] = await Promise.all([stdout, stderr, child.status]);
          expect(text).toContain('WRITE17');
          if (mode === 'handled') {
            expect(status.code).toBe(130);
            expect(status.signal).toBeNull();
            expect(errors).toContain('Interrupted; the files this run wrote were removed.');
            await expect(nodeFs.stat(`${root}/app`)).rejects.toThrow();
            expect(
              await runCli(['new', 'app', '--template', 'full-stack'], {
                fs: createNodeRuntimeServices().fs!,
                cwd: root,
                now: () => 0,
                log: () => {},
                error: () => {},
              }),
            ).toBe(0);
            expect((await nodeFs.stat(`${root}/app/main.ts`)).isFile()).toBe(true);
          } else {
            expect(status.signal).toBe('SIGINT');
            expect(status.success).toBe(false);
            expect((await nodeFs.stat(`${root}/app`)).isDirectory()).toBe(true);
            expect(errors).not.toContain('Interrupted;');
          }
        } finally {
          clearTimeout(watchdog);
          await nodeFs.rm(root, { recursive: true });
        }
      });
    }

    // The interrupt arrives while a question waits on stdin: it must end the
    // run as an interruption — exit 130, nothing written — rather than wait for
    // Enter or leave the readline interface holding the process open.
    it('ends a run interrupted at a pending prompt, writing nothing', async () => {
      await nodeFs.mkdir('.tmp', { recursive: true });
      const root = await tempDir({ dir: await nodeFs.realpath('.tmp'), prefix: 'sigint-' });
      const child = spawnFixture(root, 'prompt');
      const stderr = new Response(child.stderr).text();
      const stdout = (async () => {
        let text = '';
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout!) {
          text += decoder.decode(chunk, { stream: true });
          if (text.includes('PROMPTING')) child.kill('SIGINT');
        }
        return text;
      })();
      const watchdog = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { /* Already exited. */ }
      }, 10_000);
      try {
        const [text, errors, status] = await Promise.all([stdout, stderr, child.status]);
        expect(text).toContain('PROMPTING');
        expect(status.signal, errors).toBeNull();
        expect(status.code, errors).toBe(130);
        await expect(nodeFs.stat(`${root}/app`)).rejects.toThrow();
      } finally {
        clearTimeout(watchdog);
        await nodeFs.rm(root, { recursive: true });
      }
    });
  },
);
