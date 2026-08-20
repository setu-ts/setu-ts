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

/**
 * A file the barrel is claiming that the CLI did not generate.
 *
 * The seam scanner admits any file matching a family's suffix and exports, so a
 * hand-written `src/controllers/admin.routes.ts` becomes the CLI's on the next
 * unrelated `setu generate`. That was survivable while a duplicate route merely
 * overwrote; since M68 refuses one, an adopted file that is ALSO wired by hand stops
 * the application booting, and the error names the developer's file rather than the
 * barrel that changed (register rows X4-4 and F2).
 *
 * Adoption itself is not refused — it is usually what the developer wants — so it is
 * REPORTED, once, at the moment it happens. Membership in the existing barrel is the
 * signal: a file the barrel already names was claimed on some earlier run and is not
 * news. That needs no marker in the artifact, which matters because no artifact the
 * CLI has ever emitted carries one; requiring a marker would un-wire every artifact
 * in every existing project.
 */
export interface AdoptedArtifact {
  /** The artifact's path, relative to the project root. */
  readonly path: string;
  /** The barrel that is claiming it, relative to the project root. */
  readonly barrel: string;
}

/**
 * A candidate the scan left out because the project already registers it by hand.
 *
 * The precise detector for the case that breaks the boot. `setu.config.ts` is the one
 * wiring home the CLI's own architecture defines (M34b), and a GENERATED artifact's
 * symbol never appears there — a registration barrel exports an AGGREGATE
 * (`registerGeneratedRoutes`, `GENERATED_PLUGINS`, …), never the per-artifact symbol —
 * so a match means a hand registration and nothing else.
 *
 * That reasoning holds only for a barrel that IS a registration site, which is why the
 * check is gated on {@linkcode SeamSpec.exports} being non-empty. The functional
 * services barrel is the one seam with no exports, because it re-exports each service
 * for convenience and registers nothing — and its own header tells the developer to
 * `import { describeThing } from './src/services/index.ts'`. Reading that import as a
 * hand registration dropped the service from the barrel, so the import the CLI itself
 * documented stopped resolving and the project failed to compile, from a command that
 * reported success.
 */
export interface ManuallyWiredArtifact {
  /** The artifact's path, relative to the project root. */
  readonly path: string;
  /** The symbol found already registered. */
  readonly symbol: string;
  /** The file the hand registration was found in, relative to the project root. */
  readonly wiredIn: string;
}

/** The project's own wiring module, read once per scan. */
export interface ProjectWiring {
  /** Path relative to the project root, for the report. */
  readonly path: string;
  /** The module's source text. */
  readonly source: string;
}

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
  /** Admitted candidates the existing barrel did not already name. */
  readonly adopted: readonly AdoptedArtifact[];
  /** Candidates left out because the project registers them by hand. */
  readonly manual: readonly ManuallyWiredArtifact[];
}

/** Every family's scan result. */
export interface ArtifactScanAll {
  /** Admitted names, keyed by schematic name — the `SchematicOptions.artifacts` value. */
  readonly artifacts: SeamArtifacts;
  /** Every rejected candidate across every family. */
  readonly skipped: readonly SkippedArtifact[];
  /** Every newly-claimed candidate across every family. */
  readonly adopted: readonly AdoptedArtifact[];
  /** Every hand-registered candidate across every family. */
  readonly manual: readonly ManuallyWiredArtifact[];
}

/**
 * Reads a file's text, reporting absence as an empty string.
 *
 * A barrel that does not exist yet names nothing, and a project with no
 * `setu.config.ts` registers nothing by hand — both are ordinary states rather than
 * errors, and both mean "no evidence", which an empty source expresses exactly.
 *
 * @param fs - The filesystem to read through
 * @param path - The absolute path to read
 * @returns The text, or `''` when it cannot be read
 */
async function readTextOrEmpty(fs: IFileSystem, path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await fs.readFile(path));
  } catch {
    return '';
  }
}

/**
 * Reads the project's wiring module, for the manual-registration check.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project's root directory (absolute)
 * @returns The wiring module, or `undefined` when the project has none
 */
export async function readProjectWiring(
  fs: IFileSystem,
  dir: string,
): Promise<ProjectWiring | undefined> {
  const source = await readTextOrEmpty(fs, joinPath(dir, CONFIG_MODULE));
  return source === '' ? undefined : { path: CONFIG_MODULE, source };
}

/** The application wiring module every scaffolded project exports `createApp` from. */
const CONFIG_MODULE = 'setu.config.ts';

/**
 * Reports whether a source registers a symbol by name.
 *
 * A whole-word match rather than a parse, for the reason `exportsSymbol` gives: this
 * package carries no TypeScript parser. Every symbol passed in is a `deriveNames`
 * identifier, so it contains no regular-expression metacharacter.
 *
 * @param source - The module's source text
 * @param symbol - The identifier to look for
 * @returns True when the identifier appears
 */
function mentionsSymbol(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol}\\b`).test(source);
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
 * @param wiring - The project's wiring module, when it has one — supplied by
 *   {@linkcode scanArtifacts} so it is read once rather than once per family
 * @returns The admitted names, the rejected candidates, the newly-claimed files and
 *   the hand-registered ones
 */
export async function readArtifactNames(
  fs: IFileSystem,
  dir: string,
  spec: SeamSpec,
  wiring?: ProjectWiring,
): Promise<ArtifactScan> {
  const root = joinPath(dir, spec.dir);

  let entries: readonly string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // The directory does not exist yet, or is unreadable: no artifacts to list.
    return { names: [], skipped: [], adopted: [], manual: [] };
  }

  const barrelSource = await readTextOrEmpty(fs, joinPath(dir, spec.barrel));
  const decoder = new TextDecoder();
  const names: string[] = [];
  const skipped: SkippedArtifact[] = [];
  const adopted: AdoptedArtifact[] = [];
  const manual: ManuallyWiredArtifact[] = [];

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

    const symbols = spec.importSymbols(deriveNames(name));
    const relative = joinPath(spec.dir, entry);
    const missing = symbols.filter((symbol) => !exportsSymbol(source, symbol));
    if (missing.length > 0) {
      skipped.push({ path: relative, missing });
      continue;
    }

    // Registered by hand already: listing it in the barrel too would register it
    // twice, which the kernel refuses at boot. The developer's wiring wins — it is
    // the one they wrote — and the report says the barrel stepped aside.
    //
    // Only for a barrel that registers something. A re-export barrel has no
    // registration to duplicate, and the symbol in the config is the developer
    // consuming the barrel exactly as its header documents.
    const wired = wiring === undefined || spec.exports.length === 0
      ? undefined
      : symbols.find((symbol) => mentionsSymbol(wiring.source, symbol));
    if (wired !== undefined) {
      manual.push({ path: relative, symbol: wired, wiredIn: wiring!.path });
      continue;
    }

    if (!symbols.some((symbol) => mentionsSymbol(barrelSource, symbol))) {
      adopted.push({ path: relative, barrel: spec.barrel });
    }
    names.push(name);
  }

  return { names: names.sort(), skipped, adopted, manual };
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
 * @returns Admitted names by schematic name, plus every rejected, newly-claimed and
 *   hand-registered candidate
 */
export async function scanArtifacts(
  fs: IFileSystem,
  dir: string,
  specs: readonly SeamSpec[],
): Promise<ArtifactScanAll> {
  const artifacts: Record<string, readonly string[]> = {};
  const skipped: SkippedArtifact[] = [];
  const adopted: AdoptedArtifact[] = [];
  const manual: ManuallyWiredArtifact[] = [];
  // Read once for the whole scan: ten families would otherwise re-read one file ten
  // times against a path that is the same for all of them.
  const wiring = await readProjectWiring(fs, dir);
  for (const spec of specs) {
    const scan = await readArtifactNames(fs, dir, spec, wiring);
    artifacts[spec.schematic] = scan.names;
    skipped.push(...scan.skipped);
    adopted.push(...scan.adopted);
    manual.push(...scan.manual);
  }
  return { artifacts, skipped, adopted, manual };
}
