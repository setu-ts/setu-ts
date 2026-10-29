/** Read-only wiring gate for projects and workspace members. @module */
import type { IFileSystem } from '@setu-ts/common';
import { stringFlag, type ParsedArgs } from '../args.ts';
import { detectProject } from '../utils/project-detector.ts';
import {
  assertInsideProject,
  joinPath,
  PathEscapesProjectError,
  readExistingText,
  resolveDir,
} from '../utils/file-writer.ts';
import { readWorkspaceManifest, WORKSPACE_MANIFEST } from '../workspace/manifest.ts';
import { EXIT_ERROR, EXIT_OK } from '../constants.ts';
import { escapeName } from '../utils/names.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { diagnoseProject } from '../diagnostics/diagnose.ts';
import { readSilence } from '../diagnostics/silence.ts';
import { renderCheckFindings } from '../diagnostics/render.ts';

/** External effects shared by check and sync. */
export interface ICheckDependencies {
  readonly fs: IFileSystem;
  readonly cwd: string;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  readonly interrupt?: AbortSignal;
}

/** A thrown value's message. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Why a member's `.env` is unsafe for the generated Compose `env_file`, or `undefined` when it is
 * absent or a regular file inside the workspace.
 *
 * @param fs - The CLI's filesystem
 * @param root - The workspace root
 * @param path - `apps/<member>/.env`
 * @returns The refusal, or `undefined`
 */
export async function memberEnvProblem(
  fs: IFileSystem,
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    await assertInsideProject(fs, root, path);
  } catch (cause) {
    // Always a PathEscapesProjectError naming the link or what could not be resolved.
    return (
      `${messageOf(cause)} docker compose would follow it ` +
      "into this member's container through the generated env_file."
    );
  }
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (cause) {
    if (isMissingPath(cause)) return undefined;
    return `${escapeName(path)} cannot be inspected: ${messageOf(cause)}`;
  }
  return stat.isFile
    ? undefined
    : `${escapeName(path)} is not a regular file; replace it with one.`;
}

/** Resolves one project or every member, preserving manifest order and output prefixes. */
export async function forEachProject(
  dir: string,
  deps: ICheckDependencies,
  run: (dir: string, deps: ICheckDependencies) => Promise<number>,
): Promise<number> {
  const project = await detectProject(deps.fs, dir);
  if (project.kind === 'none') {
    deps.error(
      `${escapeName(dir)} holds no deno.json, deno.jsonc or package.json — run this inside a project, or pass --dir.`,
    );
    return EXIT_ERROR;
  }
  if (project.kind === 'unreadable') {
    deps.error(`Cannot read ${escapeName(project.path)}: ${escapeName(project.reason)}`);
    return EXIT_ERROR;
  }
  if (project.kind === 'project') return run(dir, deps);
  const read = await readWorkspaceManifest(
    {
      ...deps.fs,
      readFile: async (path) => new TextEncoder().encode(await readExistingText(deps.fs, path)),
    },
    dir,
  );
  if (!read.ok) {
    deps.error(
      `Cannot read ${escapeName(joinPath(dir, WORKSPACE_MANIFEST))}: ${read.problem.kind}`,
    );
    return EXIT_ERROR;
  }
  let code: number = EXIT_OK;
  for (const member of read.manifest.members) {
    const memberDeps: ICheckDependencies = {
      ...deps,
      log: (line) => deps.log(`${escapeName(member.name)}: ${line}`),
      error: (line) => deps.error(`${escapeName(member.name)}: ${line}`),
    };
    const memberDir = joinPath(dir, 'apps', member.name);
    // A member reached through a link would let `sync` write wherever the link
    // points, and the writer would accept it: it resolves the member root it is
    // handed. The member must resolve to its own place under the workspace.
    try {
      await assertInsideProject(deps.fs, dir, memberDir);
    } catch (cause) {
      if (!(cause instanceof PathEscapesProjectError)) throw cause;
      memberDeps.error(
        `${escapeName(memberDir)} is a symlinked member of the workspace at ${escapeName(dir)}; ` +
          'Setu will not read or write through links inside a workspace. Replace the link with ' +
          'the directory it points at, then run this again.',
      );
      code = Math.max(code, EXIT_ERROR);
      continue;
    }
    // The generated Compose file reads `apps/<member>/.env` through `env_file`, and Compose follows
    // a link. A branch committing that file as a link to a host file would put the file's variables
    // into its own container (M122 re-audit N4); the CLI cannot stop Compose, so `check` refuses it.
    const envProblem = await memberEnvProblem(deps.fs, dir, joinPath(memberDir, '.env'));
    if (envProblem !== undefined) {
      memberDeps.error(envProblem);
      code = Math.max(code, EXIT_ERROR);
    }
    const detected = await detectProject(deps.fs, memberDir);
    if (detected.kind !== 'project') {
      memberDeps.error(`${escapeName(memberDir)} is not a readable project (${detected.kind}).`);
      code = Math.max(code, EXIT_ERROR);
      continue;
    }
    code = Math.max(code, await run(memberDir, memberDeps));
  }
  return code;
}

/** Runs setu check without loading application code or writing any file. */
export async function runCheckCommand(args: ParsedArgs, deps: ICheckDependencies): Promise<number> {
  if (args.flags.help === true || args.flags.h === true) {
    deps.log('Usage: setu check [--dir <path>] [--strict]');
    deps.log('  --dir <path>  Check this project or workspace instead of the CWD');
    deps.log('  --strict      Treat warnings as errors');
    return EXIT_OK;
  }
  return await forEachProject(
    resolveDir(deps.cwd, stringFlag(args.flags, 'dir')),
    deps,
    async (dir, deps) => {
      const installed = await detectPlugins(deps.fs, dir);
      const diagnosis = await diagnoseProject(deps.fs, dir, installed);
      const result = await readSilence(deps.fs, dir, diagnosis.findings);
      if (!diagnosis.hasSeams && result.findings.length === 0)
        deps.log(`No CLI-owned seams in ${escapeName(dir)}; nothing to check.`);
      const counts = renderCheckFindings(result.findings, deps.error, args.flags.strict === true);
      deps.log(
        `setu check: ${counts.errors} error(s), ${counts.warnings} warning(s), ${result.silenced} silenced in ${escapeName(dir)}.`,
      );
      return counts.errors > 0 ? EXIT_ERROR : EXIT_OK;
    },
  );
}
