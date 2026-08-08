// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Archives every package in the retired `@hono-enterprise` JSR scope.
 *
 * ```
 * JSR_TOKEN=jsrp_… deno task release:archive-old-scope [--dry-run]
 * ```
 *
 * WHY THIS EXISTS. `v0.1.0-alpha.5` renamed the project to Setu-TS and
 * republished all 47 packages under `@setu-ts`. The 46 packages under the old
 * scope must stop looking like a live distribution, and there are three things
 * JSR lets you do to them — only one of which is correct here:
 *
 * - **Delete** — impossible. A package can only be deleted when it has no
 *   published versions, and each of these carries `alpha.1` through `alpha.4`.
 *   The scope cannot be deleted either, since that requires deleting every
 *   package in it. `@hono-enterprise` is permanent.
 * - **Yank** — deliberately NOT done. JSR's guidance is that yanking is for a
 *   version containing "a critical bug": it excludes the version from range
 *   resolution and shows a warning. These versions are not defective, they are
 *   superseded by a rename. Yanking would tell every pinned consumer their
 *   working install is broken, which is false, and would break resolution for
 *   anyone on a range.
 * - **Archive** — what this does, and what JSR recommends for a package you no
 *   longer maintain. It blocks new versions and hides the package from search
 *   and from the scope page, while existing installs keep resolving.
 *
 * Doing it by hand is one settings form per package — 46 of them.
 *
 * The token is a JSR **personal access token** from https://jsr.io/account/tokens
 * and is read from the `JSR_TOKEN` environment variable — never a CLI argument,
 * which would leave it in shell history and in the process table.
 *
 * Idempotent: a package already archived is reported and skipped, so this is
 * safe to re-run after a partial failure.
 *
 * @module
 */

// Overridable so the error paths below can be driven against a local stub — an
// untested error path is how a release script fails at the worst moment.
// Defaults to the real API; production runs never set it.
const API = Deno.env.get('JSR_API_BASE') ?? 'https://api.jsr.io';

/** The retired scope. Not `setu-ts` — archiving the live scope would be a disaster. */
const SCOPE = Deno.env.get('JSR_OLD_SCOPE') ?? 'hono-enterprise';

const dryRun = Deno.args.includes('--dry-run');
const token = Deno.env.get('JSR_TOKEN');

if (!token && !dryRun) {
  console.error(
    'JSR_TOKEN is not set.\n\n' +
      '  1. Create a personal access token at https://jsr.io/account/tokens\n' +
      '  2. Re-run with it in the environment, e.g. (fish):\n' +
      '       env JSR_TOKEN=jsrp_… deno task release:archive-old-scope\n',
  );
  Deno.exit(2);
}

/** One package as the scope listing reports it. */
type ScopePackage = { readonly name: string; readonly isArchived?: boolean };

/**
 * Lists every package in the scope.
 *
 * The list is read from the registry rather than from `release-packages.ts`,
 * because that file now names the packages of the CURRENT scope. The old scope
 * holds a different set — it never had `static-plugin`, for one — so deriving
 * the list from source would archive the wrong things and miss others.
 *
 * @returns Every package in the scope
 * @throws {Error} If the scope cannot be listed
 */
async function listScopePackages(): Promise<readonly ScopePackage[]> {
  const collected: ScopePackage[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `${API}/scopes/${SCOPE}/packages?limit=100&page=${page}`,
      { headers: token ? { 'Authorization': `Bearer ${token}` } : {} },
    );
    if (!response.ok) {
      throw new Error(
        `Could not list @${SCOPE}: ${response.status} ${await response.text()}`,
      );
    }
    const body = await response.json() as { items?: ScopePackage[] };
    const items = body.items ?? [];
    collected.push(...items);
    if (items.length < 100) return collected;
    page += 1;
  }
}

const packages = await listScopePackages();

if (packages.length === 0) {
  console.error(
    `No packages found in @${SCOPE}.\n\n` +
      'JSR only lists packages that carry a published version, so an empty\n' +
      'result here means either the scope is already fully archived (archived\n' +
      'packages are hidden from the listing) or the scope name is wrong.\n',
  );
  Deno.exit(1);
}

const archived: string[] = [];
const already: string[] = [];
const failed: { name: string; status: number; body: string }[] = [];

console.log(
  `${dryRun ? 'Simulating archive of' : 'Archiving'} ${packages.length} packages ` +
    `in @${SCOPE}…\n`,
);

for (const [index, pkg] of packages.entries()) {
  const position = `[${index + 1}/${packages.length}]`;

  if (dryRun) {
    console.log(`${position} would archive @${SCOPE}/${pkg.name}`);
    continue;
  }

  if (pkg.isArchived === true) {
    console.log(`${position} archived  @${SCOPE}/${pkg.name}`);
    already.push(pkg.name);
    continue;
  }

  const response = await fetch(`${API}/scopes/${SCOPE}/packages/${pkg.name}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isArchived: true }),
  });

  if (response.ok) {
    console.log(`${position} archiving @${SCOPE}/${pkg.name}`);
    archived.push(pkg.name);
    continue;
  }

  const body = await response.text();
  console.error(`${position} FAILED    @${SCOPE}/${pkg.name} — ${response.status} ${body}`);
  failed.push({ name: pkg.name, status: response.status, body });
}

if (dryRun) {
  console.log(`\nAll ${packages.length} packages simulated. Nothing was changed.`);
  Deno.exit(0);
}

console.log(
  `\nDone: ${archived.length} archived, ${already.length} already archived, ` +
    `${failed.length} failed.`,
);

if (failed.length > 0) {
  console.error(
    '\nArchive the rest by hand at\n' +
      failed.map((f) => `  https://jsr.io/@${SCOPE}/${f.name}/settings`).join('\n'),
  );
  Deno.exit(1);
}
