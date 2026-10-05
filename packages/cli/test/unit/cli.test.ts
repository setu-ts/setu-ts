import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { createFakeApp } from '../fixtures/fake-app.ts';
import { PROGRAM_NAME, VERSION } from '../../src/constants.ts';

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = {}): Harness {
  const fs = createFakeFs({ '/work/deno.json': '{}', ...seed });
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runCli(argv, {
        fs,
        cwd: '/work',
        now: () => Date.UTC(2026, 6, 28),
        log: out.sink,
        error: err.sink,
      }),
  };
}

describe('runCli', () => {
  it('escapes manifest pin keys and values without creating extra refusal lines', async () => {
    const controls = ['\n', '\r', '\0', '\t', '\u001b', '\u2028', '\u2029', '\u202e'];
    for (const control of controls) {
      const key = `@setu-ts/common${control}FORGED-KEY`;
      const value = `canary-pin${control}FORGED-VALUE`;
      const h = harness({
        '/work/deno.json': JSON.stringify({
          tasks: { start: 'deno run --allow-net --allow-env main.ts' },
          imports: { [key]: value },
        }),
        '/work/setu.config.ts': 'export const createApp = makeApplicationFactory();',
      });
      expect(await h.run(['devtool', 'enable'])).toBe(1);
      const lines = h.err.text().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('Framework pins in /work/deno.json disagree with this CLI:');
      const escaped = `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`;
      expect(lines[1]).toBe(
        `  @setu-ts/common${escaped}FORGED-KEY: canary-pin${escaped}FORGED-VALUE; expected jsr:@setu-ts/common${escaped}FORGED-KEY@^${VERSION}`,
      );
      expect(lines[2]).toContain('upgrade the project first');
      expect(h.fs.writes).toEqual([]);
    }
  });

  it('keeps legitimate devtool enable working after pin refusals', async () => {
    const h = harness({
      '/work/deno.json': JSON.stringify({
        tasks: { start: 'deno run --allow-net --allow-env main.ts' },
        imports: { '@setu-ts/common': `jsr:@setu-ts/common@^${VERSION}` },
      }),
      '/work/setu.config.ts': 'export const createApp = makeApplicationFactory();',
    });
    expect(await h.run(['devtool', 'enable'])).toBe(0);
    expect(h.fs.has('/work/main.dev.ts')).toBe(true);
    expect(h.err.text()).toBe('');
  });

  describe('--version', () => {
    it('prints the version from the package deno.json and returns 0', async () => {
      const h = harness();
      expect(await h.run(['--version'])).toBe(0);
      expect(h.out.text()).toBe(`${PROGRAM_NAME} ${VERSION}`);
    });

    it('accepts -v', async () => {
      const h = harness();
      expect(await h.run(['-v'])).toBe(0);
      expect(h.out.text()).toContain(VERSION);
    });

    it('reports a real semver, not a placeholder', () => {
      expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('wins over a command', async () => {
      const h = harness();
      expect(await h.run(['new', 'app', '--version'])).toBe(0);
      expect(h.fs.writes).toEqual([]);
    });
  });

  describe('help', () => {
    it('returns 0 for --help', async () => {
      const h = harness();
      expect(await h.run(['--help'])).toBe(0);
    });

    it('returns 0 for -h', async () => {
      const h = harness();
      expect(await h.run(['-h'])).toBe(0);
    });

    it('returns 0 for the help command', async () => {
      const h = harness();
      expect(await h.run(['help'])).toBe(0);
      expect(h.out.text()).toContain('Usage:');
    });

    it('returns 2 for a bare invocation but still prints usage', async () => {
      const h = harness();
      expect(await h.run([])).toBe(2);
      expect(h.out.text()).toContain('Usage:');
    });
  });

  describe('dispatch', () => {
    it('routes new', async () => {
      const h = harness();
      expect(await h.run(['new', 'app'])).toBe(0);
      expect(h.fs.has('/work/app/deno.json')).toBe(true);
    });

    it('routes the n alias', async () => {
      const h = harness();
      expect(await h.run(['n', 'app'])).toBe(0);
      expect(h.fs.has('/work/app/deno.json')).toBe(true);
    });

    it('routes generate', async () => {
      const h = harness();
      expect(await h.run(['generate', 'service', 'billing'])).toBe(0);
      expect(h.fs.has('/work/src/services/billing.service.ts')).toBe(true);
    });

    it('routes the g alias', async () => {
      const h = harness();
      expect(await h.run(['g', 'service', 'billing'])).toBe(0);
      expect(h.fs.has('/work/src/services/billing.service.ts')).toBe(true);
    });

    it('passes flags through to the command', async () => {
      const h = harness();
      expect(await h.run(['g', 'service', 'billing', '--dry-run'])).toBe(0);
      expect(h.fs.writes).toEqual([]);
    });

    it('passes --dir through to the command', async () => {
      const h = harness({ '/other/deno.json': '{}' });
      expect(await h.run(['g', 'service', 'billing', '--dir', '/other'])).toBe(0);
      expect(h.fs.has('/other/src/services/billing.service.ts')).toBe(true);
    });

    it('routes workspace maintenance with an injected port probe', async () => {
      const fs = createFakeFs({
        '/work/setu.workspace.json': JSON.stringify({
          version: 1,
          runtime: 'deno',
          basePort: 3000,
          transport: 'http',
          members: [{ name: 'orders', port: 3000 }],
        }),
        '/work/apps/orders/.setu-member': '',
      });
      const out = createRecorder();
      expect(
        await runCli(['workspace', 'ports', '--reallocate'], {
          fs,
          cwd: '/work',
          now: () => 0,
          log: out.sink,
          error: createRecorder().sink,
          portAvailable: () => Promise.resolve(true),
        }),
      ).toBe(0);
      expect(out.text()).toContain('Reallocated workspace ports');
    });

    it('routes adopt with an injected port probe', async () => {
      const fs = createFakeFs({
        '/work/setu.config.ts': 'export function createApp() {}',
        '/work/main.ts': 'await app.start({ port: 3000 });',
      });
      expect(
        await runCli(['adopt'], {
          fs,
          cwd: '/work',
          now: () => 0,
          log: createRecorder().sink,
          error: createRecorder().sink,
          portAvailable: () => Promise.resolve(true),
        }),
      ).toBe(0);
      expect(fs.has('/work/setu.workspace.json')).toBe(true);
    });
  });

  describe('exit codes', () => {
    it('returns 2 for an unknown command', async () => {
      const h = harness();
      expect(await h.run(['frobnicate'])).toBe(2);
      expect(h.err.text()).toContain('Unknown command: frobnicate');
      expect(h.fs.writes).toEqual([]);
    });

    it('returns 2 for a usage error inside a command', async () => {
      const h = harness();
      expect(await h.run(['generate', 'service'])).toBe(2);
    });

    it('returns 1 for a runtime error inside a command', async () => {
      const h = harness({ '/work/src/services/billing.service.ts': 'MINE' });
      expect(await h.run(['generate', 'service', 'billing'])).toBe(1);
    });
  });

  describe('plugin-command dispatch', () => {
    for (const command of ['commands', 'probe:run']) {
      it(`refuses already-interrupted ${command} before loading user code`, async () => {
        const controller = new AbortController();
        controller.abort();
        let loaded = false;
        const err = createRecorder();
        expect(
          await runCli([command], {
            fs: createFakeFs({ '/work/setu.config.ts': 'x' }),
            cwd: '/work',
            now: () => 0,
            log: () => {},
            error: err.sink,
            interrupt: controller.signal,
            loadApp: () => {
              loaded = true;
              return Promise.resolve({ createApp: () => createFakeApp() });
            },
          }),
        ).toBe(130);
        expect(loaded).toBe(false);
        expect(err.text()).toContain('Interrupted;');
      });
    }

    it('interrupts a pending plugin handler and awaits application shutdown', async () => {
      const controller = new AbortController();
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = createFakeApp([{
        name: 'probe:run',
        handler: () => {
          controller.abort();
          return waiting;
        },
      }]);
      const err = createRecorder();
      const code = await runCli(['probe:run'], {
        fs: createFakeFs({ '/work/setu.config.ts': 'x' }),
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: err.sink,
        interrupt: controller.signal,
        loadApp: () => Promise.resolve({ createApp: () => app }),
      });
      release();
      expect(code).toBe(130);
      expect(app.stopCount()).toBe(1);
      expect(app.isStarted()).toBe(false);
      expect(err.text()).toContain('plugin command stopped');
    });
    const appModule =
      (commands: readonly { name: string; handler: () => void }[]) => (_url: string) =>
        Promise.resolve({
          createApp: () => ({
            services: { getAll: () => commands },
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
          }),
        });

    /** A harness whose project has a config module registering `commands`. */
    function withApp(commands: readonly { name: string; handler: () => void }[]) {
      const fs = createFakeFs({
        '/work/deno.json': '{}',
        '/work/setu.config.ts': 'export function createApp() {}',
      });
      const out = createRecorder();
      const err = createRecorder();
      let booted = false;
      return {
        fs,
        out,
        err,
        wasBooted: () => booted,
        run: (argv: readonly string[]) =>
          runCli(argv, {
            fs,
            cwd: '/work',
            now: () => 0,
            log: out.sink,
            error: err.sink,
            loadApp: (url) => {
              booted = true;
              return appModule(commands)(url);
            },
          }),
      };
    }

    it('routes an unmatched first positional to the plugin commands', async () => {
      let ran = false;
      const h = withApp([{
        name: 'db:migrate',
        handler: () => {
          ran = true;
        },
      }]);
      expect(await h.run(['db:migrate'])).toBe(0);
      expect(ran).toBe(true);
    });

    it('lists commands via the commands verb', async () => {
      const h = withApp([{ name: 'db:migrate', handler: () => {} }]);
      expect(await h.run(['commands'])).toBe(0);
      expect(h.out.text()).toContain('db:migrate');
    });

    it('exits 0 from commands when the app registers none', async () => {
      const h = withApp([]);
      expect(await h.run(['commands'])).toBe(0);
    });

    describe('built-in precedence', () => {
      it('does not let a plugin shadow new', async () => {
        let shadowed = false;
        const h = withApp([{
          name: 'new',
          handler: () => {
            shadowed = true;
          },
        }]);
        expect(await h.run(['new', 'app'])).toBe(0);
        expect(shadowed).toBe(false);
        expect(h.fs.has('/work/app/deno.json')).toBe(true);
      });

      it('does not let a plugin shadow generate', async () => {
        let shadowed = false;
        const h = withApp([{
          name: 'generate',
          handler: () => {
            shadowed = true;
          },
        }]);
        expect(await h.run(['generate', 'service', 'billing'])).toBe(0);
        expect(shadowed).toBe(false);
      });

      it('does not boot the application for a built-in verb', async () => {
        // The common path must stay fast: `setu g service x` never imports
        // the user's project.
        const h = withApp([{ name: 'db:migrate', handler: () => {} }]);
        await h.run(['g', 'service', 'billing']);
        expect(h.wasBooted()).toBe(false);
      });

      it('does not boot for new, help, or --version either', async () => {
        for (const argv of [['new', 'app'], ['help'], ['--version'], ['-h']]) {
          const h = withApp([]);
          await h.run(argv);
          expect(h.wasBooted()).toBe(false);
        }
      });

      it('does boot for an unmatched command', async () => {
        const h = withApp([{ name: 'db:migrate', handler: () => {} }]);
        await h.run(['db:migrate']);
        expect(h.wasBooted()).toBe(true);
      });
    });

    it('exits 2 naming setu.config.ts when an unknown command is typed in a bare dir', async () => {
      const h = harness();
      expect(await h.run(['frobnicate'])).toBe(2);
      expect(h.err.text()).toContain('Unknown command: frobnicate');
      expect(h.err.text()).toContain('setu.config.ts');
    });
  });

  it('forwards an injected custom-schematic loader', async () => {
    const fs = createFakeFs({ '/work/deno.json': '{}' });
    const out = createRecorder();
    const code = await runCli(['g', 'custom', 'my-gen', 'thing'], {
      fs,
      cwd: '/work',
      now: () => 0,
      log: out.sink,
      error: () => {},
      load: () => Promise.resolve({ schematic: () => [{ path: 'out.txt', contents: 'hi' }] }),
    });
    expect(code).toBe(0);
    expect(fs.read('/work/out.txt')).toBe('hi');
  });

  it('forwards the prompter to `new`, which may ask and take the answers', async () => {
    // Covers the ask-forwarding branch into runNewCommand: the prompted
    // template reaches the ordinary pipeline, so the scaffold is the one the
    // equivalent flag would have produced.
    const fs = createFakeFs();
    const asked: string[] = [];
    const code = await runCli(['new', 'svc'], {
      fs,
      cwd: '/work',
      now: () => 0,
      log: () => {},
      error: () => {},
      ask: {
        select(question) {
          asked.push(question);
          return Promise.resolve(
            question.startsWith('Template?')
              ? { kind: 'answer' as const, value: 'rest' }
              : { kind: 'unavailable' as const },
          );
        },
      },
    });
    expect(code).toBe(0);
    expect(asked.length).toBeGreaterThan(0);
    expect(fs.read('/work/svc/setu.config.ts')).toContain('export function createApp');
  });
});
