import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('V13-140 --dotenv scaffold boots and reads the chosen file through a built Node launcher', async () => {
  const scratch = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(`${scratch}dotenv-launcher-`);
  try {
    const bin = `${root}/bin.js`;
    await build({
      entryPoints: [fileURLToPath(new URL('../../src/bin.ts', import.meta.url))],
      outfile: bin,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
    });
    const sourceRegister = new URL('../../../../scripts/lib/source-register.ts', import.meta.url)
      .href;
    const tsx = createRequire(import.meta.url).resolve('tsx/esm');
    const nodeArgs = ['--import', sourceRegister, '--import', tsx];
    const scaffold = spawnSync(
      process.execPath,
      [
        ...nodeArgs,
        bin,
        'new',
        'app',
        '--template',
        'rest',
        '--logger',
        'console',
        '--dotenv',
        'config/local.env',
        '--yes',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(scaffold.status, scaffold.stderr).toBe(0);
    expect(await readFile(`${root}/app/setu.config.ts`, 'utf8')).toContain(
      "envFilePath: 'config/local.env'",
    );
    await writeFile(`${root}/app/config/local.env`, 'DOTENV_LAUNCHER_PROBE=chosen-file\n');
    const probe = `
      import { createApp } from './setu.config.ts';
      import { CAPABILITIES } from '@setu-ts/common';
      const app = createApp();
      await app.start();
      try { console.log('PROBE=' + app.services.get(CAPABILITIES.CONFIG).get('DOTENV_LAUNCHER_PROBE')); }
      finally { await app.stop(); }
    `;
    const boot = spawnSync(process.execPath, [...nodeArgs, '--input-type=module', '-e', probe], {
      cwd: `${root}/app`,
      encoding: 'utf8',
    });
    expect(boot.status, boot.stderr).toBe(0);
    expect(boot.stdout).toContain('PROBE=chosen-file');
  } finally {
    await rm(root, { recursive: true });
  }
});
