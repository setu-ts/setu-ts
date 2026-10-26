/** Read-only wiring gate for projects and workspace members. @module */
import type { IFileSystem } from '@setu-ts/common';
import { stringFlag, type ParsedArgs } from '../args.ts';
import { detectProject } from '../utils/project-detector.ts';
import { joinPath, readExistingText, resolveDir } from '../utils/file-writer.ts';
import { readWorkspaceManifest, WORKSPACE_MANIFEST } from '../workspace/manifest.ts';
import { EXIT_ERROR, EXIT_OK } from '../constants.ts';
import { escapeName } from '../utils/names.ts';
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
