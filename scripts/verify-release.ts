// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Pre-publish consistency check.
 *
 * Run with the expected version (the git tag without its leading `v`):
 *
 * ```
 * deno run --allow-read scripts/verify-release.ts 0.1.0-alpha.1
 * ```
 *
 * Verifies five things a green test suite cannot:
 *
 * 1. Every publishable package carries exactly the expected version — so the
 *    tag, the CHANGELOG entry, and what lands on JSR all agree.
 * 2. Every cross-package `jsr:@hono-enterprise/*` specifier resolves to the
 *    version being published. This is the one that bites on a prerelease: a
 *    `^0.1.0` range does NOT match `0.1.0-alpha.1` under semver, so a bump
 *    that misses a specifier ships packages whose dependencies cannot resolve
 *    — and `deno publish` does not warn about it.
 * 3. The published and unpublished lists together account for every workspace
 *    member, so a newly added package cannot be silently left out.
 * 4. No publishable package is a stub (`export {}` with nothing else).
 * 5. Every entrypoint's module JSDoc opens with `@module`, so the package's
 *    README.md is what renders on jsr.io rather than a one-line JSDoc blurb.
 *    See the long comment at check 5 — six packages shipped without a visible
 *    README in `v0.1.0-alpha.2` because of this.
 *
 * Exits non-zero and prints every problem found, rather than stopping at the
 * first — a release is easier to fix in one pass.
 */
import { PUBLISHED_PACKAGES, UNPUBLISHED_PACKAGES } from './release-packages.ts';

const expected = Deno.args[0];
if (!expected) {
  console.error('usage: verify-release.ts <version>   (e.g. 0.1.0-alpha.1)');
  Deno.exit(2);
}

const problems: string[] = [];

/** Minimal shape of the fields this script reads from a package `deno.json`. */
interface PackageConfig {
  readonly name?: string;
  readonly version?: string;
  readonly imports?: Readonly<Record<string, string>>;
}

async function readConfig(dir: string): Promise<PackageConfig | null> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/deno.json`)) as PackageConfig;
  } catch {
    return null;
  }
}

// ── 1 & 2: versions and cross-package specifiers ────────────────────────────

// Matches `jsr:@hono-enterprise/<pkg>@<range>` anywhere in an import value.
const CROSS_PACKAGE = /^jsr:@hono-enterprise\/([a-z-]+)@(.+)$/;

for (const dir of PUBLISHED_PACKAGES) {
  const config = await readConfig(dir);
  if (!config) {
    problems.push(`${dir}: no readable deno.json`);
    continue;
  }

  if (config.version !== expected) {
    problems.push(`${dir}: version is ${config.version ?? '(missing)'}, expected ${expected}`);
  }

  for (const [alias, specifier] of Object.entries(config.imports ?? {})) {
    // Only in-repo packages are checked; a third-party specifier is not ours.
    if (!alias.startsWith('@hono-enterprise/')) continue;

    const match = CROSS_PACKAGE.exec(specifier);
    if (!match) {
      // A cross-package import that is not a `jsr:` specifier — typically a
      // relative path like `../common/src/index.ts`. It resolves inside the
      // workspace and therefore survives `deno check`, the test suite, AND
      // `deno publish --dry-run`, because all three resolve from the repo. It
      // does NOT survive a real publish: JSR builds the module graph from the
      // package tarball, where `../common` is outside the root, and the
      // publish fails with `Module not found "file:///common/src/index.ts"`.
      // metrics-plugin and telemetry-plugin both shipped this way and were
      // caught only when the release reached them.
      problems.push(
        `${dir}: import "${alias}" is "${specifier}", not a jsr: specifier — ` +
          `it resolves in the workspace but breaks on publish. Use ` +
          `"jsr:${alias}@^${expected}".`,
      );
      continue;
    }

    // A caret range on a prerelease (`^0.1.0-alpha.1`) matches that prerelease
    // and later versions of the same tuple. A caret range on the plain version
    // (`^0.1.0`) does NOT match any prerelease of it. Require the range to name
    // the exact version being published, in either bare or caret form.
    const range = match[2];
    if (range !== expected && range !== `^${expected}`) {
      problems.push(
        `${dir}: import "${alias}" is pinned at "${range}" but ${expected} is being published — ` +
          `the published package would have an unresolvable dependency`,
      );
    }
  }
}

// ── 3: the two lists must cover the whole workspace ─────────────────────────

const root = JSON.parse(await Deno.readTextFile('deno.json')) as { workspace?: readonly string[] };
const members = (root.workspace ?? []).map((m) => m.replace(/^\.\//, ''));
const accounted = new Set([...PUBLISHED_PACKAGES, ...UNPUBLISHED_PACKAGES]);

for (const member of members) {
  if (!accounted.has(member)) {
    problems.push(
      `${member} is a workspace member but appears in neither PUBLISHED_PACKAGES nor ` +
        `UNPUBLISHED_PACKAGES in scripts/release-packages.ts`,
    );
  }
}
for (const listed of accounted) {
  if (!members.includes(listed)) {
    problems.push(
      `${listed} is listed in scripts/release-packages.ts but is not a workspace member`,
    );
  }
}

// ── 4 & 5: entrypoint must be real, and must not hide its README ────────────

/**
 * The leading `/** … *\/` block of a source file, with the comment delimiters
 * and each line's ` * ` prefix stripped — i.e. the JSDoc body as deno_doc sees
 * it. Returns null when the file does not open with a block comment.
 */
function leadingJsDoc(source: string): string | null {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (!match) return null;
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

for (const dir of PUBLISHED_PACKAGES) {
  let source: string;
  try {
    source = await Deno.readTextFile(`${dir}/src/index.ts`);
  } catch {
    problems.push(`${dir}: no src/index.ts`);
    continue;
  }
  // A stub's only statement is `export {}`; anything real exports a binding.
  const hasRealExport = /export\s+(?:\*|\{[^}]*[A-Za-z][^}]*\}|type|const|function|class)/.test(
    source,
  );
  if (!hasRealExport) {
    problems.push(`${dir}: src/index.ts exports nothing — a stub must not be published`);
  }

  // The entrypoint's module JSDoc must open with `@module`, so that the prose
  // after it is NOT parsed as a module description.
  //
  // WHY THIS IS LOAD-BEARING. A JSR package has a `readmeSource` setting whose
  // default is `jsdoc`, and JSR renders the README only as a FALLBACK: in
  // `render_docs_html`, the entrypoint's module doc is built first, and the
  // README is substituted only `if index_module_doc.sections.docs.is_none()`.
  // deno_doc drops prose that FOLLOWS a tag, so a block opening with `@module`
  // has no description, the fallback fires, and the README renders. A block
  // whose description comes first and ends with `@module` DOES have a
  // description — so that one-paragraph blurb becomes the whole package page
  // and the hand-written README is never shown.
  //
  // Six packages (cli, feature-flags-, multi-tenancy-, openapi-, queue-,
  // storage-plugin) shipped in v0.1.0-alpha.2 with no visible README for
  // exactly this reason. Nothing else catches it: the README is present in the
  // published tarball's manifest, so `deno publish --dry-run`, the gates, and
  // the coverage bar are all green — the loss is only visible on jsr.io.
  const jsDoc = leadingJsDoc(source);
  if (jsDoc === null) {
    problems.push(
      `${dir}: src/index.ts has no leading module JSDoc — add one opening with \`@module\``,
    );
  } else if (!jsDoc.startsWith('@module')) {
    problems.push(
      `${dir}: src/index.ts module JSDoc does not open with \`@module\` — its description ` +
        `would replace README.md on jsr.io. Move \`@module\` to the first line of the block.`,
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`Release verification failed for ${expected}:\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n${problems.length} problem(s).`);
  Deno.exit(1);
}

console.log(
  `Release ${expected} verified: ${PUBLISHED_PACKAGES.length} packages to publish, ` +
    `${UNPUBLISHED_PACKAGES.length} deliberately excluded.`,
);
