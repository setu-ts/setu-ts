/**
 * @module
 *
 * Writes the `## Exports` table into every published package README.
 *
 * Run with `deno task docs:exports`. The tables are DERIVED from each package's
 * own barrel via one batched `deno doc --json` call, so they cannot be wrong by
 * hand; `deno task check:docs` fails when a barrel changes and the table does
 * not follow.
 */

// deno-lint-ignore-file no-console
import { PUBLISHED_PACKAGES } from './release-packages.ts';
import {
  collectPackageExports,
  EXPORTS_HEADING,
  renderExportsTable,
} from './package-export-collection.ts';

const groupsByPackage = await collectPackageExports(PUBLISHED_PACKAGES);

let written = 0;
for (const pkgPath of PUBLISHED_PACKAGES) {
  const groups = groupsByPackage.get(pkgPath);
  if (groups === undefined || groups.length === 0) {
    console.error(`No exports resolved for ${pkgPath}`);
    Deno.exit(1);
  }

  const readmePath = `${pkgPath}/README.md`;
  const before = await Deno.readTextFile(readmePath);
  const section = renderExportsTable(groups);

  let after: string;
  const existing = before.indexOf(`\n${EXPORTS_HEADING}\n`);
  if (existing !== -1) {
    // Replace the existing section, up to the next `##` heading.
    const rest = before.slice(existing + 1);
    const end = rest.indexOf('\n## ');
    const tail = end === -1 ? '' : rest.slice(end + 1);
    after = `${before.slice(0, existing + 1)}${section}\n\n${tail}`;
  } else {
    // Insert before the trailing "Full API" pointer when there is one, so the
    // README reads: what you get, then where the details live.
    const fullApi = before.indexOf('\n## Full API\n');
    after = fullApi === -1
      ? `${before.trimEnd()}\n\n${section}\n`
      : `${before.slice(0, fullApi + 1)}${section}\n\n${before.slice(fullApi + 1)}`;
  }

  if (after !== before) {
    await Deno.writeTextFile(readmePath, after);
    written++;
  }
}

console.log(`Exports tables written: ${written} of ${PUBLISHED_PACKAGES.length} package READMEs.`);
