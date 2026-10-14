import { readFile } from 'node:fs/promises';
/* eslint-disable no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6) */
/**
 * Pre-publish consistency check.
 *
 * Run with the expected version (the git tag without its leading `v`):
 *
 * ```
 * node scripts/verify-release.ts 0.2.0
 * ```
 *
 * Verifies eleven things a green test suite cannot:
 *
 * 1. Every publishable package carries exactly the expected version — so the
 *    tag, the CHANGELOG entry, and what lands on npm all agree.
 * 2. Every source manifest uses workspace:^ for shipped internal dependencies.
 * 3. The published and unpublished lists together account for every workspace
 *    member, so a newly added package cannot be silently left out.
 * 4. No publishable package is a stub (`export {}` with nothing else).
 * 5. Every published member carries a non-empty README.md for npm rendering.
 * 6. No package `src` tree contains a computed `import()` without a
 *    `computed-specifier` marker (M70e). JSR's npm-compatibility rewrite is
 *    static and reaches only a literal `import('npm:…')`; a computed specifier
 *    ships `npm:` verbatim and cannot load on Node or Bun (X7-3). The source
 *    gate catches the cause on every PR; this is the release backstop.
 * 7. `CHANGELOG.md` carries a non-empty section for this version. The release
 *    workflow builds the GitHub Release body from it AFTER publishing, and a
 *    npm version cannot be republished — so a missing section must fail here,
 *    before anything is uploaded, rather than leaving a red job over packages
 *    that are already live.
 * 8. The release workflow generates and attaches `resolved-set.json`. That
 *    artifact preserves the complete lockfile resolved set for the published
 *    version; a workflow edit that silently drops it must fail before release.
 *
 * 11. Every source manifest carries npm publish metadata and source/file entries.
 *
 * Exits non-zero and prints every problem found, rather than stopping at the
 * first — a release is easier to fix in one pass.
 *
 * It also REPORTS every publication hold in `PUBLICATION_HOLDS` without
 * failing on it. CI runs this on every pull request, so failing would turn
 * every unrelated PR red; `scripts/npm-publish.ts` is where a hold
 * refuses.
 * 9. Every pull request merged since the previous `v*` tag is represented in the
 *    shipping changelog section, and no milestone PR's entry sits under an
 *    already-published heading (`scripts/changelog-prs.ts`).
 * 10. The version number agrees with the shipping section: a patch carries no
 *    `BREAKING` entry, and a minor carries at least one unless
 *    `--allow-quiet-minor` says the quiet minor is deliberate
 *    (`scripts/release-shape.ts`).
 */
import { PUBLICATION_HOLDS, PUBLISHED_PACKAGES, UNPUBLISHED_PACKAGES } from './release-packages.ts';
import { packedManifestProblems } from './npm-release-gate.ts';
import { activeHolds } from './publication-hold.ts';
import { auditPackageSources } from './npm-specifier-audit.ts';
import { versionSiteProblems } from './version-sites.ts';
import { extractReleaseNotes } from './release-notes.ts';
import {
  checkChangelogPrs,
  describeFindings,
  mergedPullRequests,
  shippingSection,
} from './changelog-prs.ts';
import { bumpKind, countBreaking, shapeProblems } from './release-shape.ts';

async function main(): Promise<void> {
  const expected = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const allowQuietMinor = process.argv.slice(2).includes('--allow-quiet-minor');
  if (!expected) {
    console.error('usage: verify-release.ts <version> [--allow-quiet-minor]   (e.g. 0.2.0)');
    process.exitCode = 2;
    return;
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
      return JSON.parse(await readFile(`${dir}/deno.json`, 'utf8')) as PackageConfig;
    } catch {
      return null;
    }
  }

  // ── 1 & 2: versions and cross-package specifiers ────────────────────────────

  for (const dir of PUBLISHED_PACKAGES) {
    const config = await readConfig(dir);
    if (!config) {
      problems.push(`${dir}: no readable deno.json`);
      continue;
    }

    if (config.version !== expected) {
      problems.push(`${dir}: version is ${config.version ?? '(missing)'}, expected ${expected}`);
    }

    // M111a §3.5: the version lives at THREE sites per member — deno.json, the
    // generated package.json, and the src/version.ts literal the npm build
    // ships. A bump that misses either new site publishes a package whose
    // npm manifest or runtime VERSION disagrees with the tag.
    problems.push(
      ...versionSiteProblems(
        dir,
        expected,
        await readFile(`${dir}/package.json`, 'utf8').catch(() => null),
        await readFile(`${dir}/src/version.ts`, 'utf8').catch(() => null),
      ),
    );

    const manifest = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
    problems.push(
      ...packedManifestProblems(manifest, expected, true).map((problem) => `${dir}: ${problem}`),
    );
  }

  // ── 3: the two lists must cover the whole workspace ─────────────────────────

  const root = JSON.parse(await readFile('deno.json', 'utf8')) as { workspace?: readonly string[] };
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

  for (const dir of PUBLISHED_PACKAGES) {
    let source: string;
    try {
      source = await readFile(`${dir}/src/index.ts`, 'utf8');
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

    const readme = await readFile(`${dir}/README.md`, 'utf8').catch(() => '');
    if (readme.trim() === '') problems.push(`${dir}: README.md is missing or empty`);
  }

  // ── 6: no computed import() without a marker in packages/*/src ─────────────

  // The decidable half lives in scripts/npm-specifier-audit.ts (pure, and
  // coverage-gated via SCRIPT_TARGETS) so this check stays a thin caller. A
  // computed import() whose argument is not a string literal ships `npm:`
  // verbatim in the published artifact — JSR's static rewrite cannot see it —
  // so no release may contain one.
  const audit = await auditPackageSources('packages');
  for (const finding of audit.findings) {
    problems.push(
      `${finding.file}:${finding.line}: computed import() without a ` +
        `\`computed-specifier\` marker — JSR's static npm-compatibility rewrite ` +
        `cannot see a non-literal specifier, so any npm: string would ship ` +
        `verbatim and fail to load on Node or Bun. ${finding.snippet}`,
    );
  }
  // M111a §3.8: Node resolves neither prefix, so a published package carrying
  // one cannot load there at all.
  for (const hit of audit.prefixed) {
    problems.push(
      `${hit.file}:${hit.line}: "${hit.specifier}" is an npm:/jsr:-prefixed import — ` +
        `Node resolves neither; write the bare package name.`,
    );
  }

  // ── 7: the changelog must carry this version's release notes ───────────────

  // Checked here rather than in the workflow's release step, which runs after the
  // publish: npm versions cannot be reused, so a problem discovered there cannot be
  // fixed by re-running the job. The runbook writes the entry in step 1 and runs
  // this in step 2, so the ordering already matches.
  const changelog = await readFile('CHANGELOG.md', 'utf8').catch(() => null);
  if (changelog === null) {
    problems.push('CHANGELOG.md is missing — the release notes are built from it.');
  } else if (extractReleaseNotes(changelog, expected) === null) {
    problems.push(
      `CHANGELOG.md has no non-empty '## [${expected}]' section — the GitHub ` +
        `Release body is built from it, and that step runs after the publish, ` +
        `which cannot be repeated.`,
    );
  }

  // ── 9: every PR merged since the previous tag has an entry, in the right place ─

  // The three manual release-cutting checks that each saved a release (alpha.10,
  // v0.3.0, v0.4.0 — see scripts/changelog-prs.ts), run against the merge log.
  // Needs the tag reachable: a shallow clone fails loudly here rather than
  // passing over an empty list.
  if (changelog !== null) {
    try {
      const { previousTag, merged } = await mergedPullRequests();
      const prs = checkChangelogPrs(changelog, expected, merged);
      for (const line of describeFindings(prs)) problems.push(line);
      console.log(
        `changelog PR coverage: ${merged.length} pull request(s) merged since ${previousTag}, ` +
          `${prs.represented} represented in ${prs.shippingSection}, ${prs.exempt} exempt.`,
      );

      // ── 10: the version number agrees with what the section carries ─────────
      //
      // README's Versioning table: a 0.x PATCH carries no breaking change, a
      // MINOR carries them. From 0.9.0 a patch is the norm and breaks are
      // batched (ROADMAP "Versioning policy from 0.9.0"); this refuses the two
      // mistakes that policy depends on — see scripts/release-shape.ts.
      const bump = bumpKind(previousTag.replace(/^v/, ''), expected);
      const breaking = countBreaking(shippingSection(changelog, expected).body);
      for (const line of shapeProblems({ bump, breaking, allowQuietMinor, version: expected })) {
        problems.push(line);
      }
      console.log(
        `release shape: ${bump} from ${previousTag}, ${breaking} BREAKING entr${
          breaking === 1 ? 'y' : 'ies'
        } in the shipping section.`,
      );
    } catch (error: unknown) {
      problems.push(
        `changelog PR coverage could not run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ── 8: the GitHub Release must carry the lockfile resolved-set artifact ────

  const releaseWorkflow = await readFile('.github/workflows/release.yml', 'utf8').catch(() => null);
  if (releaseWorkflow === null) {
    problems.push(
      '.github/workflows/release.yml is missing — cannot verify release artifact wiring.',
    );
  } else {
    const requiredWorkflowFragments = [
      'name: Generate resolved-set artifact',
      'release:resolved-set',
      'actions/upload-artifact@',
      'actions/download-artifact@',
      'resolved-set.json#resolved-set.json',
    ];
    for (const fragment of requiredWorkflowFragments) {
      if (!releaseWorkflow.includes(fragment)) {
        problems.push(
          `.github/workflows/release.yml is missing ${JSON.stringify(fragment)} — ` +
            'release:verify requires the resolved-set artifact to be generated and attached.',
        );
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  // Reported, never a problem: `npm-publish.ts` is what refuses a held
  // release. Printed first so it is visible whether verification passes or not.
  for (const hold of activeHolds(PUBLICATION_HOLDS, PUBLISHED_PACKAGES)) {
    console.warn(`⚠ publication hold — ${hold.packageDir}: ${hold.reason}`);
    console.warn('  release:publish will refuse until this hold is removed.');
  }

  if (problems.length > 0) {
    console.error(`Release verification failed for ${expected}:\n`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error(`\n${problems.length} problem(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Release ${expected} verified: ${PUBLISHED_PACKAGES.length} packages to publish, ` +
      `${UNPUBLISHED_PACKAGES.length} deliberately excluded, ` +
      `${audit.markedSites} computed import() sites marked, ` +
      `${audit.filesVisited} source files audited across ` +
      `${audit.srcRootsVisited.length} src roots.`,
  );
}
if (import.meta.main) await main();
