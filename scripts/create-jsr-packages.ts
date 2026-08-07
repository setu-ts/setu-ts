// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Creates the release's packages on JSR, so that `deno publish` has somewhere
 * to publish to.
 *
 * ```
 * JSR_TOKEN=jsrp_… deno run --allow-read --allow-env --allow-net=api.jsr.io \
 *   scripts/create-jsr-packages.ts [--dry-run]
 * ```
 *
 * WHY THIS EXISTS. A JSR package must exist before anything can be published
 * to it — creating the *scope* is not enough. `deno publish` does not create
 * packages in a non-interactive session; it fails with
 *
 *     error: Following packages don't exist, follow the links and create them:
 *     - https://jsr.io/new?scope=…&package=…&from=cli
 *
 * which is a link per package. At 35 packages that is 35 manual web forms, and
 * it is the reason the first tagged release run failed. This script does the
 * same thing through the API instead.
 *
 * The token is a JSR **personal access token** from https://jsr.io/account/tokens
 * and is read from the `JSR_TOKEN` environment variable — never a CLI argument,
 * which would leave it in shell history and in the process table.
 *
 * Idempotent: a package that already exists is reported and skipped, so this is
 * safe to re-run after a partial failure.
 */
import { PUBLISHED_PACKAGES } from './release-packages.ts';

// Overridable so the error paths below can be driven against a local stub —
// the quota branch in particular is unreachable in a normal run once the quota
// has been raised, and an untested error path is how a release script fails at
// the worst moment. Defaults to the real API; production runs never set it.
const API = Deno.env.get('JSR_API_BASE') ?? 'https://api.jsr.io';
const SCOPE = 'setu-ts';

const dryRun = Deno.args.includes('--dry-run');
const token = Deno.env.get('JSR_TOKEN');

if (!token && !dryRun) {
  console.error(
    'JSR_TOKEN is not set.\n\n' +
      '  1. Create a personal access token at https://jsr.io/account/tokens\n' +
      '  2. Re-run with it in the environment, e.g. (fish):\n' +
      '       env JSR_TOKEN=jsrp_… deno task release:create-packages\n',
  );
  Deno.exit(2);
}

/** `packages/foo-plugin` → `foo-plugin` (the JSR package name within the scope). */
function packageName(dir: string): string {
  return dir.slice(dir.lastIndexOf('/') + 1);
}

const created: string[] = [];
const existing: string[] = [];
const failed: { name: string; status: number; body: string }[] = [];

for (const [index, dir] of PUBLISHED_PACKAGES.entries()) {
  const name = packageName(dir);
  const position = `[${index + 1}/${PUBLISHED_PACKAGES.length}]`;

  if (dryRun) {
    console.log(`${position} would create @${SCOPE}/${name}`);
    continue;
  }

  const response = await fetch(`${API}/scopes/${SCOPE}/packages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ package: name }),
  });

  const body = await response.text();

  if (response.ok) {
    console.log(`${position} created  @${SCOPE}/${name}`);
    created.push(name);
    continue;
  }

  // JSR reports an already-created package as a conflict. Treat that as
  // success so a re-run after a partial failure is a no-op, not an error.
  if (response.status === 409 || body.includes('packageAlreadyExists')) {
    console.log(`${position} exists   @${SCOPE}/${name}`);
    existing.push(name);
    continue;
  }

  // The weekly package-creation quota (20 per rolling 7 days by default) is
  // scope-wide, so once it is exhausted every remaining request is guaranteed
  // to fail the same way. Stop instead of firing them: the first run of this
  // script produced 15 identical errors, which buries the one line that
  // matters. See docs/releasing.md for how to request an increase.
  if (body.includes('weeklyPackageLimitExceeded')) {
    console.error(`\n${position} @${SCOPE}/${name} — weekly package-creation quota exhausted.`);
    const remaining = PUBLISHED_PACKAGES.slice(index).map(packageName);
    console.error(
      `\nStopping. ${created.length + existing.length} of ${PUBLISHED_PACKAGES.length} packages ` +
        `now exist; ${remaining.length} still needed:\n  ${remaining.join(', ')}\n\n` +
        'The quota is 20 new packages per rolling 7-day window. Either request an increase at\n' +
        `  https://jsr.io/@${SCOPE}/~/settings  →  Quotas  →  New packages per week\n` +
        'or wait for the window to roll over, then re-run this task.\n',
    );
    Deno.exit(1);
  }

  // Anything else is surfaced verbatim rather than summarised — the API's own
  // error code is the fastest way to diagnose a wrong token scope or a
  // rejected package name.
  console.error(`${position} FAILED   @${SCOPE}/${name} — HTTP ${response.status}: ${body}`);
  failed.push({ name, status: response.status, body });
}

if (dryRun) {
  console.log(`\nDry run: ${PUBLISHED_PACKAGES.length} packages would be created.`);
  Deno.exit(0);
}

console.log(
  `\n${created.length} created, ${existing.length} already existed, ${failed.length} failed.`,
);

if (failed.length > 0) {
  console.error('\nFailures:');
  for (const f of failed) console.error(`  ✗ ${f.name} — HTTP ${f.status}: ${f.body}`);
  Deno.exit(1);
}

console.log('All packages exist. `deno task release:publish` can now run.');
