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

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { getTemplate } from '../../src/templates/registry.ts';

/** Whether `npm` can be spawned on this machine. */
async function npmAvailable(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command('npm', {
      args: ['--version'],
      stdout: 'null',
      stderr: 'null',
    }).output();
    return success;
  } catch {
    return false;
  }
}

const onCi = Deno.env.get('CI') === 'true';
const hasNpm = await npmAvailable();

/** The generated `package.json` of a Workers project, minus `@setu-ts/*`. */
function workersManifest(template: string): Record<string, unknown> {
  const host = resolveHost(getTemplate(template)!, 'cloudflare-workers');
  const file = projectFiles('edge', 'cloudflare-workers', host).find((candidate) =>
    candidate.path === 'package.json'
  );
  if (file === undefined) throw new Error(`${template}: no package.json emitted`);
  const manifest = JSON.parse(file.contents) as Record<string, unknown>;
  const dependencies = (manifest['dependencies'] ?? {}) as Record<string, string>;
  manifest['dependencies'] = Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => !name.startsWith('@setu-ts/')),
  );
  return manifest;
}

describe('a Workers scaffold resolves its npm dependencies', {
  // The registry answers slowly at times, and this test is about whether npm
  // CAN resolve, not how fast.
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  // Every template that can target Workers, because each contributes its own
  // npm packages (the full-stack one adds Vite and React Router) and a peer
  // range can break on any of them.
  for (const template of ['rest', 'microservice', 'class-based', 'full-stack']) {
    it(`npm install resolves for --template ${template}`, {
      ignore: !hasNpm && !onCi,
    }, async () => {
      const dir = await Deno.makeTempDir({ prefix: 'setu-workers-install-' });
      try {
        const manifest = workersManifest(template);
        await Deno.writeTextFile(`${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
        const { code, stdout, stderr } = await new Deno.Command('npm', {
          args: ['install', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'],
          cwd: dir,
          stdout: 'piped',
          stderr: 'piped',
        }).output();
        const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

        // The output is in the assertion so a failure names the peer that broke.
        expect({ code, eresolve: output.includes('ERESOLVE') ? output : '' })
          .toEqual({ code: 0, eresolve: '' });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});
