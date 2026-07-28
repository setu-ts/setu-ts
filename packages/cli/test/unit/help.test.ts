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

  it('never spells the old hono-enterprise invocation', async () => {
    for (const argv of [['--help'], [], ['help'], ['generate', '--help']]) {
      expect(await helpText(argv)).not.toContain('hono-enterprise ');
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

  it('lists every registered schematic, from the registry', async () => {
    const text = await helpText(['--help']);
    for (const { name } of listSchematics()) {
      expect(text).toContain(name);
    }
    expect(text).toContain('custom');
  });

  it('lists all thirteen built-in schematics plus custom in generate help', async () => {
    const text = await helpText(['generate', '--help']);
    expect(listSchematics()).toHaveLength(13);
    for (const { name } of listSchematics()) {
      expect(text).toContain(name);
    }
    expect(text).toContain('custom <schematic-name>');
  });
});
