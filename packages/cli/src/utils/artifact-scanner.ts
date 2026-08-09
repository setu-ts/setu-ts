/**
 * Discovery of the generated artifacts already present in a target project.
 *
 * Each wired schematic renders a barrel listing every artifact of its family, and a
 * schematic is a pure function that performs no I/O. So the read happens here, at the
 * command layer, and the result is handed in through `SchematicOptions.artifacts` —
 * the same route `plugin-detector.ts` takes for the detected plugin set and
 * `module-scanner.ts` takes for domain modules.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { SeamArtifacts, SeamSpec } from '../seams/seam-spec.ts';
import { exportsSymbol } from '../seams/seam-spec.ts';
import { deriveNames } from './names.ts';
import { joinPath } from './file-writer.ts';

/** One candidate the scan rejected, and what it was missing. */
export interface SkippedArtifact {
  /** The path, relative to the project root. */
  readonly path: string;
  /** The symbols the barrel would have imported but the module does not export. */
  readonly missing: readonly string[];
}

/** One family's scan result. */
export interface ArtifactScan {
  /** The admitted artifact names, sorted. */
  readonly names: readonly string[];
  /** Candidates matching the suffix that were rejected, in listing order. */
  readonly skipped: readonly SkippedArtifact[];
}

/** Every family's scan result. */
export interface ArtifactScanAll {
  /** Admitted names, keyed by schematic name — the `SchematicOptions.artifacts` value. */
  readonly artifacts: SeamArtifacts;
  /** Every rejected candidate across every family. */
  readonly skipped: readonly SkippedArtifact[];
}

/**
 * Lists one family's artifact names.
 *
 * A directory entry is admitted only when all three hold:
 *
 * 1. its name ends in the spec's suffix, with a non-empty remainder;
 * 2. it is a FILE — a directory cannot be imported;
 * 3. it EXPORTS every symbol the barrel will import from it.
 *
 * The third is the one that is easy to leave out, and leaving it out was a defect. The
 * suffix says what a file claims to be; only its exports say what the barrel can name.
 * A project that generated a `middleware` or a `metric` before those artifacts gained a
 * second export had exactly this shape — the regenerated barrel imported a constant its
 * own file did not have, so the project stopped compiling from a command that reported
 * success. The same rule keeps a hand-written module in a scanned directory out of the
 * barrel, which is the flat-family form of the precondition `readModuleNames` applies to
 * a module directory.
 *
 * A rejected candidate is RETURNED rather than dropped, so the command layer can say so:
 * silently omitting it would leave the artifact unwired with no diagnostic, which is the
 * failure this milestone exists to end.
 *
 * Sorted, because `readdir` enumeration order is filesystem-defined: without a sort the
 * regenerated barrel could differ byte-for-byte between two machines holding exactly the
 * same artifacts, turning a no-op regeneration into a diff.
 *
 * A missing or unreadable directory yields an empty result rather than throwing — a
 * project that has never generated this family is the common case, not an error.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project's root directory (absolute)
 * @param spec - The family to scan for
 * @returns The admitted names and the rejected candidates
 */
export async function readArtifactNames(
  fs: IFileSystem,
  dir: string,
  spec: SeamSpec,
): Promise<ArtifactScan> {
  const root = joinPath(dir, spec.dir);

  let entries: readonly string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // The directory does not exist yet, or is unreadable: no artifacts to list.
    return { names: [], skipped: [] };
  }

  const decoder = new TextDecoder();
  const names: string[] = [];
  const skipped: SkippedArtifact[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(spec.suffix)) continue;
    const name = entry.slice(0, -spec.suffix.length);
    if (name === '') continue;

    const path = joinPath(root, entry);
    let source: string;
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile) continue;
      source = decoder.decode(await fs.readFile(path));
    } catch {
      // Vanished or unreadable between the listing and the read — skip it rather than
      // failing the whole command over one entry. Not reported as a rejection: nothing
      // is wrong with the artifact, the filesystem simply moved under us.
      continue;
    }

    const missing = spec.importSymbols(deriveNames(name)).filter(
      (symbol) => !exportsSymbol(source, symbol),
    );
    if (missing.length > 0) {
      skipped.push({ path: joinPath(spec.dir, entry), missing });
      continue;
    }
    names.push(name);
  }

  return { names: names.sort(), skipped };
}

/**
 * Scans every wired family in one pass.
 *
 * Unconditional, like `detectPlugins` and `readModuleNames`: branching on the
 * schematic name here would put a second dispatch beside the seam registry, and the
 * cost is one `readdir` per family against paths that usually do not exist.
 *
 * Families sharing a directory (`command-handler` and `query-handler` both live in
 * `src/cqrs/`) are still scanned once each, because they are told apart by suffix
 * rather than by location.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project's root directory (absolute)
 * @param specs - The families to scan
 * @returns Admitted names by schematic name, plus every rejected candidate
 */
export async function scanArtifacts(
  fs: IFileSystem,
  dir: string,
  specs: readonly SeamSpec[],
): Promise<ArtifactScanAll> {
  const artifacts: Record<string, readonly string[]> = {};
  const skipped: SkippedArtifact[] = [];
  for (const spec of specs) {
    const scan = await readArtifactNames(fs, dir, spec);
    artifacts[spec.schematic] = scan.names;
    skipped.push(...scan.skipped);
  }
  return { artifacts, skipped };
}
