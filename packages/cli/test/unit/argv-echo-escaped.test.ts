/**
 * Every refusal that quotes an argv value back renders it through `escapeName`.
 *
 * The M99e security audit (F1) found `--style` echoed raw, so a CR/LF in the
 * value forged a standalone line — `INJECTED: scaffold complete` — and an ESC
 * sequence could redraw the terminal as a success. The same shape existed at
 * every other site that quotes an argument back, so the sites are enumerated
 * here as data: one table, one assertion, and a new site that forgets the
 * escape is a row away from failing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';

const PAYLOAD = 'x\r\nINJECTED: scaffold complete';

/** Runs the CLI against one fake filesystem and returns the error text. */
async function refusal(setup: readonly (readonly string[])[], argv: readonly string[]) {
  const fs = createFakeFs();
  const deps = {
    fs,
    cwd: '/work',
    now: () => Date.UTC(2026, 6, 28),
    log: () => {},
    error: () => {},
  };
  for (const step of setup) expect(await runCli(step, deps)).toBe(0);
  const err = createRecorder();
  const code = await runCli(argv, { ...deps, error: err.sink });
  return { code, text: err.text() };
}

const WORKSPACE: readonly string[] = ['new', 'acme', '--workspace'];

const SITES: readonly (readonly [
  label: string,
  setup: readonly (readonly string[])[],
  argv: readonly string[],
])[] = [
  ['new --style', [], ['new', 'a', '--template', 'rest', '--style', PAYLOAD]],
  ['new --template', [], ['new', 'a', '--template', PAYLOAD]],
  ['new --workspace --style', [], ['new', 'ws', '--workspace', '--style', PAYLOAD]],
  ['new --workspace --template', [], ['new', 'ws', '--workspace', '--template', PAYLOAD]],
  ['new --runtime', [], ['new', 'a', '--runtime', PAYLOAD]],
  ['new --workspace --transport', [], ['new', 'ws', '--workspace', '--transport', PAYLOAD]],
  ['new --broker', [], ['new', 'a', '--template', 'microservice', '--broker', PAYLOAD]],
  ['new --workspace --port', [], ['new', 'ws', '--workspace', '--port', PAYLOAD]],
  ['new <name>', [], ['new', PAYLOAD.replace('\r\n', '\u0085')]],
  ['generate <schematic>', [], ['generate', PAYLOAD, 'widget']],
  ['generate --runtime', [], ['generate', 'service', 'widget', '--runtime', PAYLOAD]],
  ['generate app --depends-on', [WORKSPACE], [
    'generate',
    'app',
    'orders',
    '--dir',
    '/work/acme',
    '--depends-on',
    PAYLOAD,
  ]],
  ['add', [], ['add', PAYLOAD]],
  ['devtool enable <member>', [WORKSPACE], ['devtool', 'enable', PAYLOAD, '--dir', '/work/acme']],
  ['unknown option', [], ['new', 'a', `--${PAYLOAD}`]],
];

describe('an argv value quoted back in a refusal is escaped', () => {
  for (const [label, setup, argv] of SITES) {
    it(`${label}: refuses, and the value cannot forge a line`, async () => {
      const { code, text } = await refusal(setup, argv);
      expect(code).not.toBe(0);
      expect(text.includes('\r')).toBe(false);
      expect(text.includes('\u0085')).toBe(false);
      // The payload's text survives, escaped, on the same line as the
      // refusal — never as a line of its own.
      const forged = text.split('\n').filter((line) => line.startsWith('INJECTED'));
      expect(forged).toEqual([]);
      expect(text).toMatch(/\\u00(0d|85)/);
    });
  }
});
