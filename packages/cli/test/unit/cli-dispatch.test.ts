import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { createFakeApp } from '../fixtures/fake-app.ts';
import { VALUE_FLAGS } from '../../src/constants.ts';
import { parseArgs } from '../../src/args.ts';
import { commandFlagsFor } from '../../src/flags.ts';

describe('valued option dispatch', () => {
  it('accepts an equals-form value beginning with a dash', async () => {
    const fs = createFakeFs();
    expect(
      await runCli(['new', 'app', '--dir=-folder'], {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: () => {},
      }),
    ).toBe(0);
    expect(fs.has('/work/-folder/app/package.json')).toBe(true);
  });
  it('registers dotenv as a valued option in both scaffold inventories', () => {
    expect(VALUE_FLAGS.has('dotenv')).toBe(true);
    expect(VALUE_FLAGS.has('env-file')).toBe(false);
    expect(parseArgs(['--dotenv', 'config/local.env']).flags.dotenv).toBe('config/local.env');
    for (const [command, subcommand] of [
      ['new', undefined],
      ['generate', 'app'],
    ] as const) {
      const spec = commandFlagsFor(command, subcommand)!;
      expect(spec.allowed).toContain('dotenv');
      expect(spec.allowed).not.toContain('env-file');
    }
  });

  it('leaves plugin command values to their own dispatcher', async () => {
    const fs = createFakeFs({ '/work/setu.config.ts': 'x' });
    const err = createRecorder();
    let called = false;
    const app = createFakeApp([
      {
        name: 'probe:run',
        handler: () => {
          called = true;
        },
      },
    ]);
    expect(
      await runCli(['probe:run', '--dir'], {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: err.sink,
        loadApp: () => Promise.resolve({ createApp: () => app }),
      }),
    ).toBe(0);
    expect(called).toBe(true);
    expect(err.lines).toEqual([]);
  });
  it.each([
    ['template', ['new', 'app', '--template']],
    ['runtime', ['new', 'app', '--runtime']],
    ['dir', ['new', 'app', '--dir']],
    ['example', ['new', 'app', '--example']],
    ['template', ['new', 'app', '--template=']],
    ['dir', ['g', 'service', 'foo', '--dir']],
    ['depends-on', ['g', 'app', 'foo', '--depends-on', 'api', '--depends-on']],
    ['depends-on', ['g', 'app', 'foo', '--depends-on', '--depends-on', 'api']],
  ])('V13-145 refuses an empty --%s before writing', async (flag, argv) => {
    const fs = createFakeFs();
    const err = createRecorder();
    expect(
      await runCli(argv, { fs, cwd: '/work', now: () => 0, log: () => {}, error: err.sink }),
    ).toBe(2);
    expect(err.lines).toEqual([
      `Option --${flag} needs a value (write --${flag}=<value> when the value begins with "-").`,
    ]);
    expect(fs.writes).toEqual([]);
    expect(fs.mkdirs).toEqual([]);
  });

  it.each([
    ['new', 'app', '--env-file=local.env'],
    ['new', 'app', 'extra', '--env-file'],
  ])(
    'V13-140 refuses the Node-owned option before flag and positional checks: %j',
    async (...argv) => {
      const fs = createFakeFs();
      const err = createRecorder();
      expect(
        await runCli(argv, {
          fs,
          cwd: '/work',
          now: () => 0,
          log: () => {},
          error: err.sink,
        }),
      ).toBe(2);
      expect(err.lines).toEqual([
        "--env-file is Node's own option and never reaches setu under Node; use --dotenv <path>.",
      ]);
      expect(fs.writes).toEqual([]);
    },
  );

  it('V13-140 scaffolds the chosen dotenv through the dispatcher', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    expect(
      await runCli(['new', 'app', '--template', 'rest', '--dotenv', 'config/local.env'], {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: err.sink,
      }),
      err.text(),
    ).toBe(0);
    expect(fs.has('/work/app/config/local.env')).toBe(true);
    expect(fs.read('/work/app/setu.config.ts')).toContain("envFilePath: 'config/local.env'");
  });
});
