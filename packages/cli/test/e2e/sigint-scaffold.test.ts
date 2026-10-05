import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';

describe(
  { name: 'real SIGINT during scaffold writes', ignore: Deno.build.os === 'windows' },
  () => {
    for (const mode of ['handled', 'unhandled'] as const) {
      it(`${mode} signal ${mode === 'handled' ? 'rolls back' : 'leaves partial files'}`, async () => {
        await Deno.mkdir('.tmp', { recursive: true });
        const root = await Deno.makeTempDir({
          dir: await Deno.realPath('.tmp'),
          prefix: 'sigint-',
        });
        const child = new Deno.Command('deno', {
          args: [
            'run',
            '-A',
            new URL('../fixtures/sigint-scaffold.ts', import.meta.url).pathname,
            root,
            mode,
          ],
          stdout: 'piped',
          stderr: 'piped',
        }).spawn();
        const stderr = new Response(child.stderr).text();
        const stdout = (async () => {
          let text = '';
          const decoder = new TextDecoder();
          for await (const chunk of child.stdout) {
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
            await expect(Deno.stat(`${root}/app`)).rejects.toThrow();
            expect(
              await runCli(['new', 'app', '--template', 'full-stack'], {
                fs: createDenoRuntimeServices().fs!,
                cwd: root,
                now: () => 0,
                log: () => {},
                error: () => {},
              }),
            ).toBe(0);
            expect((await Deno.stat(`${root}/app/main.ts`)).isFile).toBe(true);
          } else {
            expect(status.signal).toBe('SIGINT');
            expect(status.success).toBe(false);
            expect((await Deno.stat(`${root}/app`)).isDirectory).toBe(true);
            expect(errors).not.toContain('Interrupted;');
          }
        } finally {
          clearTimeout(watchdog);
          await Deno.remove(root, { recursive: true });
        }
      });
    }
  },
);
