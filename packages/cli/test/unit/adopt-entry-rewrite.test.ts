import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runAdoptCommand } from '../../src/commands/adopt.ts';

const ENTRY = 'await app.start({ port: 3000 });\n';
const ENTRY_PATH = '/work/svc/apps/svc/main.ts';

describe('adopt entry rewrite', () => {
  it('reports a failed rewrite, restores a partial write, and never prints success guidance', async () => {
    const fs = createFakeFs({
      '/work/svc/deno.json': '{}',
      '/work/svc/setu.config.ts': 'export function createApp() {}',
      '/work/svc/main.ts': ENTRY,
    });
    const out = createRecorder();
    const err = createRecorder();
    let failed = false;
    const code = await runAdoptCommand(parseArgs([]), {
      fs: {
        ...fs,
        async writeFile(path, bytes) {
          if (
            path === ENTRY_PATH && new TextDecoder().decode(bytes).includes('SERVICE_PORT') &&
            !failed
          ) {
            failed = true;
            await fs.writeFile(path, bytes.slice(0, 5));
            throw new Error('disk full during entry rewrite');
          }
          await fs.writeFile(path, bytes);
        },
      },
      cwd: '/work/svc',
      log: out.sink,
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('disk full during entry rewrite');
    expect(err.text()).toContain(ENTRY_PATH);
    expect(fs.read(ENTRY_PATH)).toBe(ENTRY);
    expect(out.text()).not.toContain('Converted into');
    expect(out.text()).not.toContain('does not carry the port literal');
  });

  it('keeps an absent entry optional', async () => {
    const fs = createFakeFs({
      '/work/svc/deno.json': '{}',
      '/work/svc/setu.config.ts': 'export function createApp() {}',
    });
    const err = createRecorder();
    expect(
      await runAdoptCommand(parseArgs([]), {
        fs,
        cwd: '/work/svc',
        log: createRecorder().sink,
        error: err.sink,
      }),
    ).toBe(0);
    expect(err.text()).toBe('');
  });
  it('reports an unreadable entry instead of treating it as absent', async () => {
    const fs = createFakeFs({
      '/work/svc/deno.json': '{}',
      '/work/svc/setu.config.ts': 'export function createApp() {}',
      '/work/svc/main.ts': ENTRY,
    });
    const err = createRecorder();
    const out = createRecorder();
    let reads = 0;
    const result = await runAdoptCommand(parseArgs([]), {
      fs: {
        ...fs,
        readFile(path) {
          // moveFile verifies its destination by reading it once. The next read
          // is adoption's optional entry-rewrite phase.
          if (path === ENTRY_PATH && ++reads > 1) return Promise.reject('read denied');
          return fs.readFile(path);
        },
      },
      cwd: '/work/svc',
      error: err.sink,
      log: out.sink,
    });
    expect(result).toBe(1);
    expect(err.text()).toContain(`Failed to read ${ENTRY_PATH}: read denied`);
    expect(out.text()).not.toContain('Converted into');
  });
});
