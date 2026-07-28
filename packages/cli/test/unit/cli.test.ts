import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { PROGRAM_NAME, VERSION } from '../../src/constants.ts';

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = {}): Harness {
  const fs = createFakeFs(seed);
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
      const h = harness();
      expect(await h.run(['g', 'service', 'billing', '--dir', '/other'])).toBe(0);
      expect(h.fs.has('/other/src/services/billing.service.ts')).toBe(true);
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
      const fs = createFakeFs({ '/work/honoe.config.ts': 'export function createApp() {}' });
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
        // The common path must stay fast: `honoe g service x` never imports
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

    it('exits 2 naming honoe.config.ts when an unknown command is typed in a bare dir', async () => {
      const h = harness();
      expect(await h.run(['frobnicate'])).toBe(2);
      expect(h.err.text()).toContain('Unknown command: frobnicate');
      expect(h.err.text()).toContain('honoe.config.ts');
    });
  });

  it('forwards an injected custom-schematic loader', async () => {
    const fs = createFakeFs();
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
});
