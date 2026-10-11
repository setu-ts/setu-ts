import { spawnProcess, tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';

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
        const child = spawnProcess('deno', {
          args: [
            'run',
            '-A',
            new URL('../fixtures/sigint-scaffold.ts', import.meta.url).pathname,
            root,
            mode,
          ],
          stdout: 'piped',
          stderr: 'piped',
        });
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
  },
);
