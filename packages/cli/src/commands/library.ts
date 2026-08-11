/**
 * The `setu generate library` command — adds a shared library to a workspace.
 *
 * Dispatched from `generate` the way `app` and `custom` are, and for the same
 * reason: `Schematic` is a pure `(names, options) => GeneratedFile[]` performing
 * no I/O, while this reads the workspace manifest and may edit the root's member
 * glob.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, LIBRARY_VERB, PROGRAM_NAME } from '../constants.ts';
import { deriveNames, isIdentifierSafe } from '../utils/names.ts';
import {
  findExisting,
  firstDuplicatePath,
  type GeneratedFile,
  joinPath,
  writeFiles,
} from '../utils/file-writer.ts';
import { libraryFiles, librarySpecifier, LIBS_DIR } from '../workspace/library.ts';
import { readWorkspaceManifest, WORKSPACE_MANIFEST } from '../workspace/manifest.ts';
import { planRootWorkspaceGlob } from '../workspace/root-manifest.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';

/** Everything `runLibraryCommand` reaches the outside world through. */
export interface LibraryDependencies {
  /** The filesystem to read the workspace through and write the library with. */
  readonly fs: IFileSystem;
  /** The workspace root to operate on (absolute, already `--dir`-resolved). */
  readonly dir: string;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
}

/**
 * Prints the command's usage.
 *
 * @param log - Output sink
 */
function printUsage(log: (message: string) => void): void {
  log(`Usage: ${PROGRAM_NAME} generate ${LIBRARY_VERB} <name> [--scope <scope>] [--dir <path>]`);
  log('');
  log(`Adds shared code to a Setu workspace: creates ${LIBS_DIR}/<name>/, which every`);
  log(`member can import by name. No member's manifest changes — a workspace resolves`);
  log(`a member by its declared name, under every supported toolchain. On npm and Bun`);
  log(`the link is made by the install, so re-run it before importing the library.`);
  log('');
  log('Options:');
  log('  --scope <scope>     Import scope, without the @ (default: the workspace directory)');
  log('  --dir <path>        The workspace root, instead of the working directory');
  log('  --dry-run           Print what would be created, write nothing');
}

/**
 * The scope a library's specifier is published under.
 *
 * Derived from the workspace ROOT DIRECTORY rather than recorded in
 * `setu.workspace.json`, because the manifest has no name field and adding one
 * would be a shape change for a value the directory already carries. `--scope`
 * overrides it for a workspace whose directory is not what its packages should be
 * called.
 *
 * @param dir - The workspace root (absolute)
 * @param override - The `--scope` value, when given
 * @returns The scope, without the leading `@`
 */
function resolveScope(dir: string, override?: string): string {
  if (override !== undefined) return override.replace(/^@/, '');
  const base = dir.split('/').filter((part) => part !== '').at(-1) ?? 'workspace';
  return deriveNames(base).kebab;
}

/**
 * Runs `setu generate library`.
 *
 * @param args - Arguments after the `generate` verb, already parsed
 * @param deps - Filesystem, workspace root, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runLibraryCommand(
  args: ParsedArgs,
  deps: LibraryDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printUsage(deps.log);
    return EXIT_OK;
  }

  const rawName = args.positionals[1];
  if (rawName === undefined) {
    printUsage(deps.error);
    return EXIT_USAGE;
  }

  const names = deriveNames(rawName);
  if (!isIdentifierSafe(names)) {
    deps.error(
      `Invalid name "${rawName}": it must contain a letter and must not start with a digit.`,
    );
    return EXIT_USAGE;
  }

  // A library is only importable by NAME from inside a workspace, so this is
  // refused outside one rather than producing a directory nothing can reach.
  const read = await readWorkspaceManifest(deps.fs, deps.dir);
  if (!read.ok) {
    deps.error(
      `No usable ${WORKSPACE_MANIFEST} in ${deps.dir}, so this is not a Setu workspace.`,
    );
    deps.error(
      `A library is resolved by the workspace, so it needs one: create it with ` +
        `\`${PROGRAM_NAME} new <name> --workspace\`.`,
    );
    return EXIT_ERROR;
  }

  const rawScope = args.flags['scope'];
  if (rawScope !== undefined && typeof rawScope !== 'string') {
    deps.error('--scope needs a value: the import scope, without the leading @.');
    return EXIT_USAGE;
  }
  const scope = resolveScope(deps.dir, rawScope);

  // The workspace's own toolchain: a library carrying a deno.json inside an npm
  // workspace is invisible to every member that would import it.
  const profile = workspaceProfile(read.manifest.runtime);
  const files: GeneratedFile[] = [...libraryFiles(scope, names, profile)];

  // Only ever an edit for a workspace created before libraries existed: a root
  // this CLI wrote already declares the glob, so this is `unchanged` there.
  let rootManifest = '';
  try {
    rootManifest = new TextDecoder().decode(
      await deps.fs.readFile(joinPath(deps.dir, profile.rootManifestFile)),
    );
  } catch {
    // Left empty: the planner refuses an unreadable root, naming the library.
  }
  const rootPlan = planRootWorkspaceGlob(
    rootManifest,
    profile.memberGlob(LIBS_DIR),
    names.kebab,
    profile.rootManifestFile,
    profile.globKey,
  );
  if (rootPlan.kind === 'refused') {
    deps.error(rootPlan.message);
    return EXIT_ERROR;
  }
  if (rootPlan.kind === 'update') files.push(rootPlan.file);

  const duplicate = firstDuplicatePath(files);
  if (duplicate !== undefined) {
    deps.error(`Refusing to plan ${duplicate} twice; it would be written and then overwritten.`);
    return EXIT_ERROR;
  }

  const planned = files.map((file) => ({ ...file, path: joinPath(deps.dir, file.path) }));

  if (args.flags['dry-run'] === true) {
    for (const file of planned) deps.log(`would create ${file.path}`);
    return EXIT_OK;
  }

  const existing = await findExisting(deps.fs, planned);
  if (existing.length > 0) {
    deps.error('Refusing to overwrite existing files:');
    for (const path of existing) deps.error(`  ${path}`);
    return EXIT_ERROR;
  }

  try {
    await writeFiles(deps.fs, planned);
  } catch (cause) {
    deps.error(`Failed to write: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_ERROR;
  }

  for (const file of planned) deps.log(`created ${file.path}`);
  deps.log('');
  deps.log(`Added the ${librarySpecifier(scope, names.kebab)} library. Import it anywhere:`);
  deps.log(`  import { ${names.camel} } from '${librarySpecifier(scope, names.kebab)}';`);

  // Not advice — a requirement, and measured: on npm and Bun a workspace package
  // is reachable through a symlink the INSTALL creates in the root
  // `node_modules`, so until that runs again the import above fails to resolve.
  // Deno needs nothing: it resolves a member from the manifest glob directly.
  if (profile.manifestKind === 'npm') {
    deps.log('');
    deps.log(`Run \`${profile.install}\` first — a workspace package is linked into node_modules`);
    deps.log(`by the install, so the import above cannot resolve until it does.`);
  }
  return EXIT_OK;
}
