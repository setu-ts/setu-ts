/**
 * Turning an existing single-service project into a workspace with that service
 * as its first member.
 *
 * The scaffolded shape is `apps/<name>/…` with a root manifest above it, so a
 * conversion has to MOVE files — which is the reason this was left out of M62 and
 * the reason it is written the way it is here.
 *
 * **It moves only what the CLI itself emits.** The list comes from the project
 * renderer, not from a directory walk, and that is a correctness property rather
 * than caution: `.git` must stay at the repository root, so must a CI
 * configuration, and so must `deno.lock` — a workspace has ONE lockfile, at the
 * top. A conversion that moved "everything" would relocate the repository's
 * history into `apps/<name>/.git` and quietly break the checkout.
 *
 * **Every move is copy → verify → delete, in that order.** `IFileSystem` has no
 * rename, so a move is three operations, and the order decides what a failure
 * leaves behind: this way a crash leaves the file in BOTH places, which is
 * recoverable and reported. The other order loses it.
 *
 * @module
 */

import type { IFileSystem, StatResult } from '@setu-ts/common';

import { CONFIG_MODULE } from '../constants.ts';
import { configuredEnvFilePath, isCoveredDotenvName } from '../templates/env-file.ts';
import { assertInsideProject, joinPath } from '../utils/file-writer.ts';
import { escapeName } from '../utils/names.ts';

/**
 * The files and directories a conversion relocates into the member.
 *
 * Every entry is one the CLI emits itself (`templates/project-files.ts` and the
 * seam barrels), plus `deno.jsonc`: Deno reads it as the project's manifest
 * exactly as it reads `deno.json`, so a project that renamed its manifest still
 * has one, and leaving it at the root would put it beside the workspace's new
 * `deno.json` — two manifests in one directory, the project's own ignored —
 * while the moved member had none. Anything else in the project directory stays
 * where it is, which is what keeps `.git`, `.github`, `deno.lock`, `node_modules`
 * and any file a developer added at the repository root — where they belong for
 * a workspace.
 */
export const ADOPTED_ENTRIES: readonly string[] = [
  'deno.json',
  'deno.jsonc',
  'package.json',
  '.npmrc',
  'tsconfig.json',
  'wrangler.toml',
  'main.ts',
  CONFIG_MODULE,
  'README.md',
  'vite.config.ts',
  'react-router.config.ts',
  'src',
  'app',
  'test',
];

/**
 * The subset of {@linkcode ADOPTED_ENTRIES} that are directories.
 *
 * Named rather than derived at run time, because it is read AFTER the move — by
 * then the directories are empty and a `stat` cannot tell which of them this
 * command was responsible for.
 */
export const ADOPTED_DIRECTORIES: readonly string[] = ['src', 'app', 'test'];

/** The starter packages that register `HealthPlugin` and `MetricsPlugin` themselves. */
const STARTER_PACKAGES: ReadonlySet<string> = new Set([
  'rest-starter',
  'microservice-starter',
  'full-stack-starter',
]);

/**
 * What an existing project's dependencies declare about its probe endpoints.
 *
 * Recorded in the member's manifest entry so the Kubernetes renderer — which sees
 * only the manifest — can decide between `httpGet` and `tcpSocket` probes. A
 * starter registers both plugins unconditionally, which is why any of them counts
 * for both. This is a dependency declaration, not proof of registration: a
 * project can declare the plugin and never register it, which the generated
 * README warns about alongside custom endpoint paths.
 *
 * @param installed - The bare `@setu-ts` package names the project declares
 * @returns Whether the member declares health probes and a metrics endpoint
 */
export function probeSupport(installed: ReadonlySet<string>): {
  readonly healthProbes: boolean;
  readonly metricsEndpoint: boolean;
} {
  const starter = [...STARTER_PACKAGES].some((pkg) => installed.has(pkg));
  return {
    healthProbes: starter || installed.has('health-plugin'),
    metricsEndpoint: starter || installed.has('metrics-plugin'),
  };
}

/** One entry a conversion will relocate. */
export interface AdoptedFile {
  /** Path relative to the project root, e.g. `src/routes/index.ts`. */
  readonly from: string;
  /** Path relative to the workspace root, e.g. `apps/orders/src/routes/index.ts`. */
  readonly to: string;
}

/** A file a conversion writes, rather than one it moves. */
export interface AdoptCreatedFile {
  /** Path relative to the workspace root, e.g. `apps/svc/.gitignore`. */
  readonly path: string;
  /** The file contents. */
  readonly contents: string;
  /** Generated output the CLI owns, so a conversion may append to it. */
  readonly managed?: boolean;
}

/** What planning a conversion produced. */
export type AdoptPlan =
  | {
      readonly ok: true;
      readonly files: readonly AdoptedFile[];
      /** Files to write beside the moves, through the same transaction. */
      readonly creates?: readonly AdoptCreatedFile[];
      /** A step the developer must take by hand, in the order it is reported. */
      readonly notes?: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Lists every file under a directory, relative to it.
 *
 * @param fs - The filesystem to read through
 * @param root - The directory to walk (absolute)
 * @param prefix - The relative prefix accumulated so far
 * @returns Relative paths of the files found
 */
export async function walkProjectFiles(
  fs: IFileSystem,
  root: string,
  prefix: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(joinPath(root, prefix))) {
    const relative = prefix === '' ? entry : joinPath(prefix, entry);
    // A committed link would otherwise be FOLLOWED: a linked directory walked
    // and its files moved — deleting them where they live, outside the project.
    await assertInsideProject(fs, root, joinPath(root, relative));
    const stat = await fs.stat(joinPath(root, relative));
    if (stat.isDirectory) {
      found.push(...(await walkProjectFiles(fs, root, relative)));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/**
 * Plans which of a project's files move into `apps/<member>/`.
 *
 * A directory in {@linkcode ADOPTED_ENTRIES} is walked, so nested source moves
 * with its parent; an entry that is not present is skipped, because the set spans
 * every template and no project has all of them.
 *
 * @param fs - The filesystem to read through
 * @param project - The existing project directory (absolute)
 * @param memberRoot - Where the member lands, relative to the workspace root
 * @returns The moves, or the refusal to print
 */
export async function planAdoption(
  fs: IFileSystem,
  project: string,
  memberRoot: string,
): Promise<AdoptPlan> {
  // The one file that makes this a Setu project. Without it there is no plugin
  // list to move and nothing here would produce a working member.
  try {
    await fs.stat(joinPath(project, CONFIG_MODULE));
  } catch {
    return {
      ok: false,
      message:
        `No ${CONFIG_MODULE} in ${escapeName(project)}, so this is not a Setu project. ` +
        `A conversion needs one: it becomes the first member's application factory.`,
    };
  }

  const files: AdoptedFile[] = [];
  for (const entry of ADOPTED_ENTRIES) {
    let isDirectory: boolean;
    try {
      isDirectory = (await fs.stat(joinPath(project, entry))).isDirectory;
    } catch {
      // Absent: the entry set spans every template, and no project has all of it.
      continue;
    }

    // Checked whatever its kind: a linked DIRECTORY with nothing inside it would
    // otherwise never be checked, since a directory is reached through its children.
    try {
      await assertInsideProject(fs, project, joinPath(project, entry));
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }

    if (!isDirectory) {
      files.push({ from: entry, to: joinPath(memberRoot, entry) });
      continue;
    }

    // A walk fails on an entry it cannot stat — a dangling symlink, which git
    // commits happily, or an unreadable directory. Reported as a refusal, not
    // left to escape as an uncaught error that prints the raw path.
    let nested: readonly string[];
    try {
      nested = await walkProjectFiles(fs, project, entry);
    } catch (cause) {
      return {
        ok: false,
        message: `Cannot read every file under ${escapeName(joinPath(project, entry))}: ${escapeName(
          (cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, ''),
        )}. Fix or remove that entry, then run this again.`,
      };
    }
    for (const path of nested) {
      files.push({ from: path, to: joinPath(memberRoot, path) });
    }
  }

  // The dotenv pair is not a static entry: its name comes from the project's own
  // `envFilePath`. It moves with the member because each member runs in
  // `apps/<member>/`, where `envFilePath: '.env'` would otherwise read nothing —
  // and the miss is silent because the generated config sets `envFileOptional`.
  const notes: string[] = [];
  const creates: AdoptCreatedFile[] = [];
  const configured = await readConfiguredEnvPath(fs, project);
  if (configured !== undefined) {
    if (configured.includes('/')) {
      // A `.gitignore` pattern WITH a slash is anchored to its directory, so the
      // root rule would stop matching after the move. Left in place, with the step
      // named rather than silently unignored.
      notes.push(
        `The configured envFilePath "${configured}" spans directories, so it was not moved: ` +
          `move it into ${joinPath(memberRoot, configured)} by hand and add an ignore rule for ` +
          `it — a pattern containing a slash is anchored to its directory.`,
      );
    } else {
      const planned = new Set(files.map((file) => file.from));
      for (const [index, name] of [configured, `${configured}.example`].entries()) {
        if (planned.has(name)) continue;
        let isDirectory: boolean;
        try {
          isDirectory = (await fs.stat(joinPath(project, name))).isDirectory;
        } catch {
          // Absent: the example is optional, and a project need not commit either.
          continue;
        }
        if (isDirectory) continue;
        try {
          await assertInsideProject(fs, project, joinPath(project, name));
        } catch (cause) {
          return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
        }
        files.push({ from: name, to: joinPath(memberRoot, name) });
        // Only the dotenv file itself, never its `.example`, which stays committed.
        if (index === 0) {
          const gitignore = await memberGitignore(fs, project, memberRoot, name);
          if (!gitignore.ok) return { ok: false, message: gitignore.message };
          creates.push(gitignore.file);
          if (!isCoveredDotenvName(name)) {
            // The workspace-relative path, not the bare name: `.dockerignore` sits at
            // the workspace root, where a pattern without a slash matches only there.
            notes.push(
              `Add ${escapeName(joinPath(memberRoot, name))} to .dockerignore: the generated ` +
                `rules cover only .env and .env.* names, so this file would be copied into the image.`,
            );
          }
        }
      }
    }
  }

  // A member's own generated file can land on a path a repository committed as a
  // link — `apps/<member>/.gitignore` is the one that happens. Refused here,
  // before either a dry run prints a plan or the transaction moves the first file.
  for (const file of creates) {
    try {
      await assertInsideProject(fs, project, joinPath(project, file.path));
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  return {
    ok: true,
    files,
    ...(notes.length === 0 ? {} : { notes }),
    ...(creates.length === 0 ? {} : { creates }),
  };
}

/**
 * The largest existing member `.gitignore` a generated rule is appended to.
 *
 * The file is generated output, not a data file, so anything this size is not
 * something the conversion wrote or a developer edited by hand — and reading it
 * is the one path where a committed link or special file could consume memory
 * without bound before the containment check below has a say.
 */
const MAX_MEMBER_GITIGNORE_BYTES = 64 * 1024;

/** The result of planning the member's own `.gitignore`: the file, or why it was refused. */
type MemberGitignorePlan =
  | { readonly ok: true; readonly file: AdoptCreatedFile }
  | { readonly ok: false; readonly message: string };

/**
 * Plans the member's own `.gitignore` for a dotenv file the conversion moves.
 *
 * A root rule such as `/.env` is anchored to the repository root and stops
 * matching the file once it lives under `apps/<member>/`. A nested `.gitignore`
 * is anchored to its own directory, so the same line keeps the moved file
 * ignored whatever the root rule says.
 *
 * Written through the conversion's ordinary write batch, not here: an
 * interrupted adopt rolls it back with everything else.
 *
 * **Checked before it is read.** This path is predictable, so a repository can
 * commit a link or a special file there: a link to `/dev/zero` reads forever and
 * a FIFO never returns. The containment check runs first (refusing a link, as
 * every other path does), then the kind and size are read from `stat` — only a
 * regular file under the size bound is opened at all.
 *
 * @param fs - The filesystem to read the member path through
 * @param project - The project root (absolute)
 * @param memberRoot - Where the member lands, relative to the workspace root
 * @param name - The moved dotenv file's name
 * @returns The file the conversion should write, or the refusal to print
 */
async function memberGitignore(
  fs: IFileSystem,
  project: string,
  memberRoot: string,
  name: string,
): Promise<MemberGitignorePlan> {
  const path = joinPath(memberRoot, '.gitignore');
  const target = joinPath(project, path);
  let existing = '';
  let metadata: StatResult | undefined;
  try {
    metadata = await fs.stat(target);
  } catch {
    // The member directory is new, so this is the normal case. A pre-existing
    // file is appended to rather than overwritten.
  }
  if (metadata !== undefined) {
    try {
      await assertInsideProject(fs, project, target);
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (!metadata.isFile) {
      return {
        ok: false,
        message:
          `${escapeName(target)} is not a regular file, so Setu will not append the member's ` +
          'ignore rule to it. Replace it with a file, or remove it, then run this again.',
      };
    }
    if (metadata.size > MAX_MEMBER_GITIGNORE_BYTES) {
      return {
        ok: false,
        message:
          `${escapeName(target)} is ${metadata.size} bytes, larger than the 64 KiB a generated ` +
          'ignore rule is appended to. Trim it, then run this again.',
      };
    }
    try {
      existing = new TextDecoder().decode(await fs.readFile(target));
    } catch {
      // The file was there a moment ago; a read failure leaves the generated
      // contents as they would be for a new member rather than failing planning.
    }
  }
  const comment =
    '# Generated by `setu adopt`: the moved dotenv file is anchored to this member directory.';
  const contents =
    existing === ''
      ? `${comment}\n/${name}\n`
      : `${existing.endsWith('\n') ? existing : `${existing}\n`}/${name}\n`;
  return { ok: true, file: { path, contents, managed: true } };
}

/**
 * Reads a project's configured dotenv path, tolerating an unreadable config.
 *
 * The config's presence was checked before planning; this is the contents read.
 * A failure here means the file cannot be moved meaningfully anyway, so planning
 * skips the pair rather than turning conversion into a read error.
 *
 * @param fs - The filesystem to read through
 * @param project - The project directory
 * @returns The validated path, or `undefined`
 */
async function readConfiguredEnvPath(
  fs: IFileSystem,
  project: string,
): Promise<string | undefined> {
  try {
    return configuredEnvFilePath(
      new TextDecoder().decode(await fs.readFile(joinPath(project, CONFIG_MODULE))),
    );
  } catch {
    return undefined;
  }
}

/** What a single move did. */
export type MoveOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Moves one file: copy, verify, then delete the original.
 *
 * The verification is a byte-length comparison rather than a hash — enough to
 * catch a truncated write, which is the failure that would otherwise delete the
 * only copy of a file.
 *
 * @param fs - The filesystem to move through
 * @param project - The project root the paths are relative to (absolute)
 * @param file - The move to perform
 * @returns Whether it completed
 */
export async function moveFile(
  fs: IFileSystem,
  project: string,
  file: AdoptedFile,
): Promise<MoveOutcome> {
  const from = joinPath(project, file.from);
  const to = joinPath(project, file.to);

  try {
    // Both ends: the source was checked when planned, but a destination under a
    // committed `apps` link would put the moved files outside the project.
    await assertInsideProject(fs, project, from);
    await assertInsideProject(fs, project, to);
    const bytes = await fs.readFile(from);
    const parent = to.slice(0, to.lastIndexOf('/'));
    if (parent !== '') await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(to, bytes);

    const written = await fs.readFile(to);
    if (written.byteLength !== bytes.byteLength) {
      return {
        ok: false,
        message:
          `Copied ${escapeName(file.from)} to ${escapeName(file.to)} but the copy is ` +
          `${written.byteLength} bytes against ${bytes.byteLength} — the original is untouched.`,
      };
    }

    // Only now. A crash before this leaves the file in both places, which is
    // recoverable; the other order loses it.
    await fs.rm(from);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: `Failed to move ${escapeName(file.from)}: ${escapeName(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    };
  }
}

/**
 * Removes an adopted directory once every file under it has moved.
 *
 * Without this the project keeps an empty `src/` (and `app/`, `test/`) at the
 * workspace root: `moveFile` deletes files, and a directory whose files have all
 * left is still there. An empty `src/` beside `apps/` reads as a second place
 * source might live.
 *
 * It removes ONLY a directory it can prove is empty of files, and reports the
 * ones it cannot — a symlink, or something a walk cannot classify, is left alone
 * rather than deleted recursively on an assumption.
 *
 * @param fs - The filesystem to prune through
 * @param project - The project root (absolute)
 * @param directories - Top-level directory names that were adopted
 * @returns The directories left in place, with files still in them
 */
export async function pruneAdoptedDirectories(
  fs: IFileSystem,
  project: string,
  directories: readonly string[],
): Promise<readonly string[]> {
  const kept: string[] = [];
  for (const directory of directories) {
    const path = joinPath(project, directory);
    try {
      if (!(await fs.stat(path)).isDirectory) continue;
      const remaining = await walkProjectFiles(fs, project, directory);
      if (remaining.length > 0) {
        kept.push(directory);
        continue;
      }
      await fs.rm(path, { recursive: true });
    } catch {
      // Unreadable or already gone: nothing to prune, and nothing to report — the
      // move itself would have failed loudly first.
    }
  }
  return kept;
}

/**
 * Rewrites the member's entry to bind its allocated port.
 *
 * A standalone project's entry either reads `PORT` from the runtime services (the
 * current form, defaulting to `3000`) or carries the legacy literal `3000`; a
 * member binds the port the workspace allocated it, read from the generated
 * discovery module, so the port it binds and the port its siblings dial stay ONE
 * datum.
 *
 * Returns `undefined` when either piece is missing — the start line or the
 * `createApp` import — because a developer may have changed the entry, and the
 * caller then reports the two lines to change rather than guessing at an edit.
 *
 * @param entry - The existing entry's contents
 * @param symbol - The exported constant to bind instead
 * @param specifier - The module to import it from
 * @returns The rewritten entry, or undefined when it does not match
 */
export function rewriteEntryPort(
  entry: string,
  symbol: string,
  specifier: string,
): string | undefined {
  // Both shipped forms: the current entry reads PORT from the runtime services
  // (X4-10), and a project scaffolded before that carries the literal. Quotes
  // are either kind because Prettier may have rewritten the file.
  const current = /await app\.start\(\{ port: Number\(runtime\.env\.PORT \?\? (['"])3000\1\) \}\);/;
  const legacy = /await app\.start\(\{ port: 3000 \}\);/;
  const binding = current.exec(entry) ?? legacy.exec(entry);
  if (binding === null) return undefined;

  // The import goes immediately after the createApp import, wherever that is and
  // whichever quote style the file uses. Without it there is no `createApp` call
  // to keep the port beside, so the entry is not the shape this rewrites.
  //
  // Matched line by line rather than with a regex: `import { [^}]+ } from …`
  // backtracks quadratically on a line that repeats `import { ` thousands of
  // times, and this file's contents are project-supplied.
  const modulePath = `./${CONFIG_MODULE}`;
  const suffixes = [` } from '${modulePath}';`, ` } from "${modulePath}";`];
  const lines = entry.split('\n');
  let configImportLine = '';
  let configImportIndex = -1;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('import { ')) continue;
    const suffix = suffixes.find((candidate) => line.endsWith(candidate));
    if (suffix === undefined) continue;
    const middle = line.slice('import { '.length, line.length - suffix.length);
    if (middle === '' || middle.includes('}')) continue;
    configImportLine = line;
    configImportIndex = index;
    break;
  }
  if (configImportIndex === -1) return undefined;

  const afterImport =
    lines.slice(0, configImportIndex).reduce((total, line) => total + line.length + 1, 0) +
    configImportLine.length;
  const withImport =
    entry.slice(0, afterImport) +
    `\nimport { ${symbol} } from '${specifier}';` +
    entry.slice(afterImport);

  return withImport.replace(binding[0], `await app.start({ port: ${symbol} });`);
}
