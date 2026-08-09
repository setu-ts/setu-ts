import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { PROGRAM_NAME, TARGET_RUNTIMES } from '../../src/constants.ts';
import { listSchematics } from '../../src/schematics/registry.ts';

async function helpText(argv: readonly string[]): Promise<string> {
  const out = createRecorder();
  await runCli(argv, {
    fs: createFakeFs(),
    cwd: '/work',
    now: () => 0,
    log: out.sink,
    error: () => {},
  });
  return out.text();
}

describe('help output', () => {
  it('interpolates PROGRAM_NAME', async () => {
    expect(await helpText(['--help'])).toContain(PROGRAM_NAME);
  });

  it('never spells the old setu-ts invocation', async () => {
    for (const argv of [['--help'], [], ['help'], ['generate', '--help']]) {
      expect(await helpText(argv)).not.toContain('setu-ts ');
    }
  });

  it('names both commands and their aliases', async () => {
    const text = await helpText(['--help']);
    expect(text).toContain('new, n');
    expect(text).toContain('generate, g');
  });

  it('documents every runtime target', async () => {
    const text = await helpText(['--help']);
    for (const runtime of TARGET_RUNTIMES) {
      expect(text).toContain(runtime);
    }
  });

  it('documents --dry-run and --dir', async () => {
    const text = await helpText(['--help']);
    expect(text).toContain('--dry-run');
    expect(text).toContain('--dir');
  });

  it('documents --di on new, where the flag is accepted', async () => {
    const text = await helpText(['new', '--help']);
    expect(text).toContain('--di');
    expect(text).toContain('DiPlugin');
    // Also in the usage line, so it is visible without reading the options list.
    expect(text).toContain('[--di]');
  });

  // `generate` reads the project's manifest to learn what is installed, so a
  // --di flag there would be a second, contradictable source of the same fact.
  it('does not offer --di on generate', async () => {
    // Word-boundary matched, not substring: `generate --help` documents
    // `--dir <path>`, which contains `--di`.
    expect(/--di\b/.test(await helpText(['generate', '--help']))).toBe(false);
    expect(/--di\b/.test(await helpText(['new', '--help']))).toBe(true);
  });

  it('lists every registered schematic, from the registry', async () => {
    const text = await helpText(['--help']);
    for (const { name } of listSchematics()) {
      expect(text).toContain(name);
    }
    expect(text).toContain('custom');
  });

  it('lists all fourteen built-in schematics plus custom in generate help', async () => {
    const text = await helpText(['generate', '--help']);
    expect(listSchematics()).toHaveLength(14);
    for (const { name } of listSchematics()) {
      expect(text).toContain(name);
    }
    expect(text).toContain('custom <schematic-name>');
  });
});
