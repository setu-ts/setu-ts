// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Sets the description and runtime-compat flags on every release package's JSR
 * page.
 *
 * ```
 * JSR_TOKEN=jsrp_… deno task release:set-metadata [--dry-run]
 * ```
 *
 * WHY THIS EXISTS. Both settings live only on the package, never in a published
 * version: `deno publish` uploads a tarball and never touches them, so they stay
 * empty however many times a package publishes. Every package in this scope went
 * out with `"description": ""` and `"runtimeCompat": {}`, which is what a reader
 * sees on jsr.io and what the package score is computed against — the same class
 * of loss as the suppressed READMEs, invisible to every local gate because
 * nothing in the tarball is wrong.
 *
 * Doing it by hand is one web form per package, with six fields each.
 *
 * The token is a JSR **personal access token** from https://jsr.io/account/tokens
 * and is read from the `JSR_TOKEN` environment variable — never a CLI argument,
 * which would leave it in shell history and in the process table.
 *
 * Idempotent: a package whose description and flags already match is reported and
 * skipped, so this is safe to re-run after a partial failure, and safe to run on
 * every release to pick up newly added packages.
 *
 * WHY TWO REQUESTS PER PACKAGE. The endpoint takes an externally-tagged enum,
 * not a partial object:
 *
 * ```rust
 * pub enum ApiUpdatePackageRequest {
 *   Description(String),
 *   GithubRepository(Option<…>),
 *   RuntimeCompat(ApiRuntimeCompat),
 *   ReadmeSource(ApiReadmeSource),
 *   IsFeatured(bool),
 *   IsArchived(bool),
 * }
 * ```
 *
 * So exactly one variant travels per request, and a body carrying both fields is
 * rejected with `400 malformedRequest` — serde stops at the second key, which is
 * why the reported column landed on the opening quote of `"runtimeCompat"` rather
 * than anywhere meaningful. `link-jsr-repos.ts` never met this because it happens
 * to send a single field. Each field is therefore PATCHed separately and skipped
 * independently, so a package can have a current description and a stale compat
 * matrix without either request being wasted.
 */
import { PUBLISHED_PACKAGES } from './release-packages.ts';
import { PACKAGE_METADATA, type RuntimeCompat } from './jsr-metadata.ts';

// Overridable so the error paths below can be driven against a local stub — an
// untested error path is how a release script fails at the worst moment.
const API = Deno.env.get('JSR_API_BASE') ?? 'https://api.jsr.io';
const SCOPE = 'hono-enterprise';

const dryRun = Deno.args.includes('--dry-run');
const token = Deno.env.get('JSR_TOKEN');

if (!token && !dryRun) {
  console.error(
    'JSR_TOKEN is not set.\n\n' +
      '  1. Create a personal access token at https://jsr.io/account/tokens\n' +
      '  2. Re-run with it in the environment, e.g. (fish):\n' +
      '       env JSR_TOKEN=jsrp_… deno task release:set-metadata\n',
  );
  Deno.exit(2);
}

/** `packages/foo-plugin` → `foo-plugin` (the JSR package name within the scope). */
function packageName(dir: string): string {
  return dir.slice(dir.lastIndexOf('/') + 1);
}

const names = PUBLISHED_PACKAGES.map(packageName);

// A package published with no entry here would keep an empty page silently, and
// an entry naming a package that is not published is a typo that would otherwise
// look like a successful no-op. Both are caught before any request is sent.
const undescribed = names.filter((n) => !(n in PACKAGE_METADATA));
const unknown = Object.keys(PACKAGE_METADATA).filter((n) => !names.includes(n));

if (undescribed.length > 0 || unknown.length > 0) {
  if (undescribed.length > 0) {
    console.error(
      `No metadata for ${undescribed.length} published package(s):\n` +
        undescribed.map((n) => `  ${n}`).join('\n') +
        '\n\nAdd an entry to scripts/jsr-metadata.ts.',
    );
  }
  if (unknown.length > 0) {
    console.error(
      `\nMetadata for ${unknown.length} package(s) that are not published:\n` +
        unknown.map((n) => `  ${n}`).join('\n'),
    );
  }
  Deno.exit(1);
}

/** The description and flags a package currently carries, or undefined if unreadable. */
async function current(
  name: string,
): Promise<{ description: string; runtimeCompat: RuntimeCompat } | undefined> {
  const response = await fetch(`${API}/scopes/${SCOPE}/packages/${name}`, {
    headers: token === undefined ? {} : { 'Authorization': `Bearer ${token}` },
  });
  if (!response.ok) return undefined;
  return await response.json() as { description: string; runtimeCompat: RuntimeCompat };
}

/** Whether the live compat flags already equal the intended ones. */
function compatMatches(live: RuntimeCompat, want: RuntimeCompat): boolean {
  const keys: (keyof RuntimeCompat)[] = ['browser', 'deno', 'node', 'workerd', 'bun'];
  return keys.every((k) => live[k] === want[k]);
}

/**
 * Sends one enum variant. Returns the failure, or undefined on success.
 *
 * `body` carries exactly one key because the endpoint's request type admits
 * exactly one — see the module comment.
 */
async function patch(
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string } | undefined> {
  const response = await fetch(`${API}/scopes/${SCOPE}/packages/${name}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return undefined;
  return { status: response.status, body: await response.text() };
}

const updated: string[] = [];
const already: string[] = [];
const failed: { name: string; status: number; body: string }[] = [];

console.log(
  `${dryRun ? 'Simulating' : 'Setting'} description and runtime compat on ` +
    `${names.length} packages…\n`,
);

for (const [index, name] of names.entries()) {
  const want = PACKAGE_METADATA[name];
  const position = `[${index + 1}/${names.length}]`;

  if (dryRun) {
    const flags = (['browser', 'deno', 'node', 'workerd', 'bun'] as const)
      .map((k) => `${k}=${want.runtimeCompat[k] ?? '?'}`)
      .join(' ');
    console.log(`${position} would set @${SCOPE}/${name}\n${' '.repeat(9)}${flags}`);
    continue;
  }

  const live = await current(name);
  const needsDescription = live === undefined || live.description !== want.description;
  const needsCompat = live === undefined || !compatMatches(live.runtimeCompat, want.runtimeCompat);

  if (!needsDescription && !needsCompat) {
    console.log(`${position} current  @${SCOPE}/${name}`);
    already.push(name);
    continue;
  }

  // One request per field: the endpoint accepts a single enum variant.
  const failure =
    (needsDescription ? await patch(name, { description: want.description }) : undefined) ??
      (needsCompat ? await patch(name, { runtimeCompat: want.runtimeCompat }) : undefined);

  if (failure === undefined) {
    const what = [needsDescription ? 'description' : null, needsCompat ? 'compat' : null]
      .filter((s) => s !== null).join(' + ');
    console.log(`${position} setting  @${SCOPE}/${name} (${what})`);
    updated.push(name);
    continue;
  }

  console.error(`${position} FAILED   @${SCOPE}/${name} — ${failure.status} ${failure.body}`);
  failed.push({ name, ...failure });
}

if (dryRun) {
  console.log(`\nAll ${names.length} packages simulated.`);
  Deno.exit(0);
}

console.log(
  `\nDone: ${updated.length} updated, ${already.length} already current, ${failed.length} failed.`,
);

if (failed.length > 0) {
  console.error(
    '\nSet these by hand at\n' +
      failed.map((f) => `  https://jsr.io/@${SCOPE}/${f.name}/settings`).join('\n'),
  );
  Deno.exit(1);
}
