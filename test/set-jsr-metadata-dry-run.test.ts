import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { run } from '../scripts/lib/run.ts';
import { jsrSunsetDescription } from '../scripts/jsr-sunset.ts';
import { PACKAGE_METADATA } from '../scripts/jsr-metadata.ts';

it('lists 49 exact sunset descriptions without a token or network use', async () => {
  const root = resolve(import.meta.dirname, '..');
  await mkdir(resolve(root, '.tmp'), { recursive: true });
  const preload = resolve(root, '.tmp/m111f-no-network.mjs');
  await writeFile(
    preload,
    'globalThis.fetch = () => { throw new Error("Network forbidden in dry run"); };\n',
  );
  const env = { ...process.env };
  delete env.JSR_TOKEN;
  try {
    const result = await run(
      process.execPath,
      ['--import', preload, 'scripts/set-jsr-metadata.ts', '--dry-run'],
      { cwd: root, env },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.match(/would set @setu-ts\//g)).toHaveLength(49);
    expect(result.stdout).toContain(
      jsrSunsetDescription('kernel', PACKAGE_METADATA['kernel']!.description),
    );
    expect(result.stdout).toContain('All 49 packages simulated.');
    for (const name of ['localization-plugin', 'idempotency-plugin', 'create'])
      expect(result.stdout).not.toContain(`would set @setu-ts/${name}\n`);
  } finally {
    await rm(preload, { force: true });
  }
});
