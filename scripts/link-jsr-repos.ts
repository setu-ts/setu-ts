// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Links every release package on JSR to this GitHub repository, which is what
 * lets the tag-triggered workflow publish without a token.
 *
 * ```
 * JSR_TOKEN=jsrp_… deno task release:link-repos [--dry-run]
 * ```
 *
 * WHY THIS EXISTS. Tokenless publishing from GitHub Actions authenticates with
 * the runner's OIDC identity, and JSR will only accept that identity for a
 * package it knows belongs to the repository. Per JSR's docs:
 *
 *   "To publish from GitHub Actions, you must first link your package to your
 *    GitHub repository from your package settings in JSR."
 *
 * Without the link, `deno publish` gets as far as uploading and then fails with
 *
 *     error: Failed to publish @setu-ts/common@…
 *     Caused by:
 *         The actor that this request was authenticated for is not authorized
 *         to access this resource. (actorNotAuthorized)
 *
 * which is what the `v0.1.0-alpha.2` run hit. `v0.1.0-alpha.1` never surfaced
 * it because that release was published from a terminal with a token, where the
 * link is irrelevant.
 *
 * Doing it by hand is one web form per package — 36 of them.
 *
 * The token is a JSR **personal access token** from https://jsr.io/account/tokens
 * and is read from the `JSR_TOKEN` environment variable — never a CLI argument,
 * which would leave it in shell history and in the process table. The JSR
 * account behind the token must have access to the GitHub repository; JSR checks
 * that through the account's GitHub association, not through the token.
 *
 * Idempotent: a package already linked to this repository is reported and
 * skipped, so this is safe to re-run after a partial failure.
 */
import { PUBLISHED_PACKAGES } from './release-packages.ts';

// Overridable so the error paths below can be driven against a local stub — an
// untested error path is how a release script fails at the worst moment.
// Defaults to the real API; production runs never set it.
const API = Deno.env.get('JSR_API_BASE') ?? 'https://api.jsr.io';
const SCOPE = 'setu-ts';
const OWNER = Deno.env.get('JSR_REPO_OWNER') ?? 'setu-ts';
const REPO = Deno.env.get('JSR_REPO_NAME') ?? 'setu-ts';

const dryRun = Deno.args.includes('--dry-run');
const token = Deno.env.get('JSR_TOKEN');

if (!token && !dryRun) {
  console.error(
    'JSR_TOKEN is not set.\n\n' +
      '  1. Create a personal access token at https://jsr.io/account/tokens\n' +
      '  2. Re-run with it in the environment, e.g. (fish):\n' +
      '       env JSR_TOKEN=jsrp_… deno task release:link-repos\n',
  );
  Deno.exit(2);
}

/** `packages/foo-plugin` → `foo-plugin` (the JSR package name within the scope). */
function packageName(dir: string): string {
  return dir.slice(dir.lastIndexOf('/') + 1);
}

/** The repository a package is currently linked to, or undefined when unlinked. */
async function currentLink(name: string): Promise<string | undefined> {
  const response = await fetch(`${API}/scopes/${SCOPE}/packages/${name}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!response.ok) return undefined;
  const pkg = await response.json() as {
    githubRepository?: { owner?: string; name?: string } | null;
  };
  const repo = pkg.githubRepository;
  return repo?.owner === undefined ? undefined : `${repo.owner}/${repo.name}`;
}

const linked: string[] = [];
const already: string[] = [];
const failed: { name: string; status: number; body: string }[] = [];

console.log(
  `${dryRun ? 'Simulating' : 'Linking'} ${PUBLISHED_PACKAGES.length} packages ` +
    `to ${OWNER}/${REPO}…\n`,
);

for (const [index, dir] of PUBLISHED_PACKAGES.entries()) {
  const name = packageName(dir);
  const position = `[${index + 1}/${PUBLISHED_PACKAGES.length}]`;

  if (dryRun) {
    console.log(`${position} would link @${SCOPE}/${name} → ${OWNER}/${REPO}`);
    continue;
  }

  if (await currentLink(name) === `${OWNER}/${REPO}`) {
    console.log(`${position} linked   @${SCOPE}/${name}`);
    already.push(name);
    continue;
  }

  const response = await fetch(`${API}/scopes/${SCOPE}/packages/${name}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ githubRepository: { owner: OWNER, name: REPO } }),
  });

  if (response.ok) {
    console.log(`${position} linking  @${SCOPE}/${name} → ${OWNER}/${REPO}`);
    linked.push(name);
    continue;
  }

  const body = await response.text();
  console.error(`${position} FAILED   @${SCOPE}/${name} — ${response.status} ${body}`);
  failed.push({ name, status: response.status, body });
}

if (dryRun) {
  console.log(`\nAll ${PUBLISHED_PACKAGES.length} packages simulated.`);
  Deno.exit(0);
}

console.log(
  `\nDone: ${linked.length} linked, ${already.length} already linked, ${failed.length} failed.`,
);

if (failed.length > 0) {
  console.error(
    '\nUnlinked packages cannot be published from GitHub Actions. Link them by hand at\n' +
      failed.map((f) => `  https://jsr.io/@${SCOPE}/${f.name}/settings`).join('\n'),
  );
  Deno.exit(1);
}
