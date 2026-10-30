import { run as runProcess, tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { dirname } from 'node:path';
/**
 * A Workers scaffold's npm devDependencies resolve against the live registry.
 *
 * The first step the CLI prints for a Workers project is
 * `npm install && npx wrangler dev`, and on 2026-10-07 it failed for every new
 * project: the emitted `wrangler: '^4.0.0'` resolved to 4.148.0, whose
 * `peerOptional @cloudflare/workers-types@^5.20261006.1` excluded the
 * `^4.20250109.0` pinned beside it, so npm refused with ERESOLVE. Nothing in
 * the repository had changed — an upstream release broke a range the CLI had
 * emitted unchanged since it shipped — so only a test that ASKS the registry can
 * see that class of failure. This one does, and it runs in the scheduled
 * dependency-drift job as well as on every pull request, which is the point:
 * the next such release turns that job red instead of reaching a user.
 *
 * It is a `--dry-run` with `--ignore-scripts`: npm builds the full ideal tree
 * (which is where ERESOLVE is raised) and downloads, writes and executes
 * nothing. Measured against the defect: the old pin exits 1 with ERESOLVE, the
 * new one exits 0, in about a second each.
 *
 * The `@setu-ts/*` dependencies are removed before installing, deliberately.
 * `setu new` pins them to the CLI's own version, which during a release bump is
 * not published yet, so leaving them in would make the release workflow's own
 * test step fail with ETARGET against the publish that would fix it (the M34b
 * deadlock). They declare no peer on any of the packages under test, so the
 * resolution this checks is unaffected.
 *
 * Guarded on `npm` being on PATH so a machine without Node can still run the
 * suite — but NOT under CI, where a missing npm fails instead, so the check can
 * never become a silent skip on the runners that exist to run it.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { getTemplate } from '../../src/templates/registry.ts';
import { npmInstall, npmRun, startOverlay } from '../fixtures/node-project.ts';

/** Whether `npm` can be spawned on this machine. */
async function npmAvailable(): Promise<boolean> {
  try {
    const { success } = await runProcess('npm', {
      args: ['--version'],
      stdout: 'null',
      stderr: 'null',
    });
    return success;
  } catch {
    return false;
  }
}

const onCi = process.env['CI'] === 'true';
const hasNpm = await npmAvailable();

/** The generated `package.json` of a Workers project, minus every `@setu-ts/*` entry. */
function workersManifest(template: string): Record<string, unknown> {
  const host = resolveHost(getTemplate(template)!, 'cloudflare-workers');
  const file = projectFiles('edge', 'cloudflare-workers', host).find(
    (candidate) => candidate.path === 'package.json',
  );
  if (file === undefined) throw new Error(`${template}: no package.json emitted`);
  const manifest = JSON.parse(file.contents) as Record<string, unknown>;
  // Both sections: a Workers project also pins `@setu-ts/cli` as a devDependency.
  for (const section of ['dependencies', 'devDependencies']) {
    const entries = (manifest[section] ?? {}) as Record<string, string>;
    manifest[section] = Object.fromEntries(
      Object.entries(entries).filter(([name]) => !name.startsWith('@setu-ts/')),
    );
  }
  return manifest;
}

describe('a Workers scaffold resolves its npm dependencies', () => {
  // Every template that can target Workers, because each contributes its own
  // npm packages (the full-stack one adds Vite and React Router) and a peer
  // range can break on any of them.
  for (const template of ['rest', 'microservice', 'class-based', 'full-stack']) {
    it(
      `npm install resolves for --template ${template}`,
      {
        skip: !hasNpm && !onCi,
      },
      async () => {
        const dir = await tempDir({ prefix: 'setu-workers-install-' });
        try {
          const manifest = workersManifest(template);
          await nodeFs.writeFile(`${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
          const { code, stdout, stderr } = await runProcess('npm', {
            args: ['install', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'],
            cwd: dir,
            stdout: 'piped',
            stderr: 'piped',
          });
          const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

          // The output is in the assertion so a failure names the peer that broke.
          expect({ code, eresolve: output.includes('ERESOLVE') ? output : '' }).toEqual({
            code: 0,
            eresolve: '',
          });
        } finally {
          await nodeFs.rm(dir, { recursive: true });
        }
      },
    );
  }

  // V9-9: one `tsconfig.json` type-checks the Worker source AND `vite.config.ts`,
  // which imports `node:fs`. Before the fix the Workers project named neither
  // `@types/node` nor `node` in `types`, so its own `npm run check` failed on a
  // pristine scaffold. Installed from the overlay because that is the tree's own
  // packed tarballs — the same thing npm serves after a release.
  it(
    'type-checks the Workers full-stack scaffold with its own check script',
    { skip: !hasNpm && !onCi, timeout: 900_000 },
    async () => {
      const dir = await tempDir({ prefix: 'setu-workers-check-' });
      const overlay = await startOverlay();
      try {
        const host = resolveHost(getTemplate('full-stack')!, 'cloudflare-workers');
        for (const file of projectFiles('edge', 'cloudflare-workers', host)) {
          const path = `${dir}/${file.path}`;
          await nodeFs.mkdir(dirname(path), { recursive: true });
          await nodeFs.writeFile(path, file.contents);
        }

        const install = await npmInstall(dir, overlay);
        expect(install.code, install.output.slice(-4000)).toBe(0);

        // The entry imports `../build/server/index.js`, which exists only after a
        // build. A pristine scaffold's own `check` script therefore builds
        // first; this asserts the scaffold as emitted, with no manual step.
        const check = await npmRun(dir, 'check');
        // The output is in the assertion so a failure names the missing type
        // rather than only the exit code.
        expect(check.code, check.output.slice(-4000)).toBe(0);
      } finally {
        await overlay.close();
        await nodeFs.rm(dir, { recursive: true });
      }
    },
  );
});
