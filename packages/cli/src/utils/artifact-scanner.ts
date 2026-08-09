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
import { joinPath } from './file-writer.ts';

/**
 * Lists one family's artifact names.
 *
 * A directory entry counts only when it is a FILE whose name ends in the spec's
 * suffix, with a non-empty remainder. Both halves matter: a directory named
 * `x.routes.ts` cannot be imported, and a bare `.routes.ts` would derive an empty
 * symbol name. Admitting either would make the regenerated barrel import something
 * that does not exist, so the developer's project would fail to compile naming a file
 * they never created — from a command that reported success.
 *
 * Sorted, because `readdir` enumeration order is filesystem-defined: without a sort
 * the regenerated barrel could differ byte-for-byte between two machines holding
 * exactly the same artifacts, turning a no-op regeneration into a diff.
 *
 * A missing or unreadable directory yields an empty list rather than throwing — a
 * project that has never generated this family is the common case, not an error.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project's root directory (absolute)
 * @param spec - The family to scan for
 * @returns The artifact names, sorted, or `[]` when there are none
 */
export async function readArtifactNames(
  fs: IFileSystem,
  dir: string,
  spec: SeamSpec,
): Promise<readonly string[]> {
  const root = joinPath(dir, spec.dir);

  let entries: readonly string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // The directory does not exist yet, or is unreadable: no artifacts to list.
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(spec.suffix)) continue;
    const name = entry.slice(0, -spec.suffix.length);
    if (name === '') continue;

    let isFile: boolean;
    try {
      isFile = (await fs.stat(joinPath(root, entry))).isFile;
    } catch {
      // Vanished or unreadable between the listing and the probe — skip it rather
      // than failing the whole command over one entry.
      continue;
    }
    if (isFile) names.push(name);
  }

  return names.sort();
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
 * @returns Artifact names keyed by schematic name
 */
export async function scanArtifacts(
  fs: IFileSystem,
  dir: string,
  specs: readonly SeamSpec[],
): Promise<SeamArtifacts> {
  const artifacts: Record<string, readonly string[]> = {};
  for (const spec of specs) {
    artifacts[spec.schematic] = await readArtifactNames(fs, dir, spec);
  }
  return artifacts;
}
