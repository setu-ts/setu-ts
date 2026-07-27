// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Publishes the implemented workspace packages to JSR, one at a time and in
 * dependency order.
 *
 * ```
 * deno run --allow-read --allow-run=deno scripts/publish-packages.ts [--dry-run]
 * ```
 *
 * Why not a single workspace-wide `deno publish`? Because the workspace also
 * contains the `cli`, `sdk`, and starter stubs, which export nothing. JSR
 * versions are immutable — a stub published by accident can be yanked but
 * never removed — so the package set is an explicit allow-list
 * (`scripts/release-packages.ts`) rather than whatever the workspace happens
 * to contain.
 *
 * Publishing stops at the first failure. A partially published release is
 * recoverable (re-run after fixing; already-published versions are skipped by
 * JSR), but continuing past a failure would publish dependents against a
 * dependency version that does not exist.
 */
import { PUBLISHED_PACKAGES } from './release-packages.ts';

const dryRun = Deno.args.includes('--dry-run');

// `deno publish` falls back to interactive browser auth only when it is
// attached to a TTY. It is not one here — this script spawns it as a
// subprocess, and CI has no terminal at all — so without a token it fails with
// "No means to authenticate. Pass a token to `--token`."
//
// The token is read from the environment rather than taken as an argument so
// it stays out of shell history and the process table. In GitHub Actions the
// variable is left unset: the runner's OIDC identity authenticates instead.
const token = Deno.env.get('JSR_TOKEN');

/** `packages/foo-plugin` → `foo-plugin`. */
function packageName(dir: string): string {
  return dir.slice(dir.lastIndexOf('/') + 1);
}

/** The version this workspace member declares. */
async function declaredVersion(dir: string): Promise<string> {
  const config = JSON.parse(await Deno.readTextFile(`${dir}/deno.json`)) as { version?: string };
  return config.version ?? '';
}

/**
 * Whether `version` is already live on JSR.
 *
 * JSR versions are immutable, so re-publishing one is not merely wasteful — it
 * is an error that aborts the run. A release that stopped partway (this one
 * stopped at 20 of 35 on the weekly package-creation quota) therefore cannot be
 * resumed by simply re-running: the first already-published package would kill
 * it before reaching the ones that still need publishing. Checking the registry
 * first makes a resume genuinely idempotent.
 *
 * A registry lookup that fails for any other reason returns `false` — publish
 * and let `deno publish` be the authority, rather than silently skipping a
 * package because of a transient network error.
 */
async function alreadyPublished(dir: string, version: string): Promise<boolean> {
  try {
    const response = await fetch(`https://jsr.io/@hono-enterprise/${packageName(dir)}/meta.json`);
    if (!response.ok) return false;
    const meta = (await response.json()) as { versions?: Record<string, unknown> };
    return Object.hasOwn(meta.versions ?? {}, version);
  } catch {
    return false;
  }
}

console.log(
  `${dryRun ? 'Simulating' : 'Publishing'} ${PUBLISHED_PACKAGES.length} packages to JSR…\n`,
);

let skipped = 0;

for (const [index, dir] of PUBLISHED_PACKAGES.entries()) {
  const position = `[${index + 1}/${PUBLISHED_PACKAGES.length}]`;
  const version = await declaredVersion(dir);

  if (!dryRun && await alreadyPublished(dir, version)) {
    console.log(`${position} ${dir} — already at ${version}, skipping`);
    skipped++;
    continue;
  }

  console.log(`${position} ${dir}`);

  const args = ['publish', '--config', `${dir}/deno.json`];
  if (dryRun) args.push('--dry-run');
  if (token) args.push('--token', token);

  const { success } = await new Deno.Command('deno', {
    args,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();

  if (!success) {
    console.error(
      `\n${dir} failed. Stopping — dependents would publish against a missing version.`,
    );
    Deno.exit(1);
  }
}

if (dryRun) {
  console.log(`\nAll ${PUBLISHED_PACKAGES.length} packages simulated.`);
} else {
  const published = PUBLISHED_PACKAGES.length - skipped;
  console.log(
    `\nDone: ${published} published, ${skipped} already at this version. ` +
      `${PUBLISHED_PACKAGES.length} total.`,
  );
}
