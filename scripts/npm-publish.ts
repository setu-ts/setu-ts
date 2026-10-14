import { run as runProcess } from './lib/run.ts';
import { mkdir, realpath, readFile } from 'node:fs/promises';
/* eslint-disable no-console -- release orchestration prints its checked artifacts. */
/** Packs, checks, looks up and publishes immutable npm tarballs in dependency order. @module */
import { PUBLICATION_HOLDS, PUBLISHED_PACKAGES } from './release-packages.ts';
import { publicationHoldRefusal } from './publication-hold.ts';
import {
  distTagFor,
  npmSupportsTrustedPublishing,
  packedManifestProblems,
  packumentHasVersion,
} from './npm-release-gate.ts';

/** Process seam; tests observe the same command and lookup order as the real run. */
export interface PublishOptions {
  readonly dryRun: boolean;
  readonly inCi: boolean;
  readonly command?: (cmd: string, args: readonly string[], cwd?: string) => Promise<string>;
  readonly fetchImpl?: typeof fetch;
}

async function command(cmd: string, args: readonly string[], cwd = '.'): Promise<string> {
  const result = await runProcess(cmd, args, { cwd });
  const output = result.stdout;
  console.log(output);
  const stderr = result.stderr;
  if (stderr !== '') console.error(stderr);
  if (!(result.code === 0)) {
    throw new Error(`${cmd} failed (exit ${result.code}); stopping before dependents`);
  }
  return output;
}

/** Executes the publisher; dry runs include the unauthenticated registry lookup. */
export async function runNpmPublish(options: PublishOptions): Promise<void> {
  const refusal = publicationHoldRefusal(PUBLICATION_HOLDS, PUBLISHED_PACKAGES);
  if (refusal !== null) throw new Error(refusal);
  const execute = options.command ?? command;
  const fetchImpl = options.fetchImpl ?? fetch;
  const npm = await execute('npm', ['--version']);
  if (!npmSupportsTrustedPublishing(npm)) throw new Error(`npm ${npm.trim()} is older than 11.5.1`);
  await execute('pnpm', ['exec', 'tsc', '-b']);
  await mkdir('.tmp/npm-pack', { recursive: true });
  const packDir = await realpath('.tmp/npm-pack');
  let skipped = 0;
  let performed = 0;
  for (const [index, dir] of PUBLISHED_PACKAGES.entries()) {
    const source = JSON.parse(await readFile(`${dir}/package.json`, 'utf8')) as {
      name: string;
      version: string;
    };
    const packed = await execute(
      'pnpm',
      ['pack', '--ignore-scripts', '--pack-destination', packDir],
      dir,
    );
    const reported = packed
      .trim()
      .split('\n')
      .reverse()
      .find((line) => line.endsWith('.tgz'));
    if (reported === undefined) throw new Error(`${dir}: pack reported no tarball`);
    const tarball = reported.startsWith('/') ? reported : `${packDir}/${reported}`;
    const manifest = JSON.parse(await execute('tar', ['-xzOf', tarball, 'package/package.json']));
    const problems = packedManifestProblems(manifest, source.version);
    if (problems.length > 0) {
      throw new Error(`${dir}: packed manifest refused: ${problems.join('; ')}`);
    }
    const url = `https://registry.npmjs.org/${source.name.replace('/', '%2f')}`;
    const response = await fetchImpl(url);
    console.log(
      `[${
        index + 1
      }/${PUBLISHED_PACKAGES.length}] packed manifest OK; GET ${url}: ${response.status}`,
    );
    if (response.status !== 404 && !response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    if (response.ok && packumentHasVersion(await response.json(), source.version)) {
      skipped++;
      console.log(`${source.name}@${source.version} already published; skipping`);
      continue;
    }
    const args = [
      'publish',
      tarball,
      '--access',
      'public',
      '--tag',
      distTagFor(source.version),
      '--ignore-scripts',
    ];
    if (options.inCi) args.push('--provenance');
    if (options.dryRun) args.push('--dry-run');
    await execute('npm', args);
    performed++;
  }
  console.log(
    `Done: ${performed} ${
      options.dryRun ? 'simulated' : 'published'
    }, ${skipped} already at this version. ${PUBLISHED_PACKAGES.length} packed, checked and looked up.`,
  );
}

if (import.meta.main) {
  await (async () => {
    await runNpmPublish({
      dryRun: process.argv.slice(2).includes('--dry-run'),
      inCi: process.env['GITHUB_ACTIONS'] === 'true',
    });
  })();
}
