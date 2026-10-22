/** The opt-in agent brief writer and read-only freshness check. */
import type { IFileSystem } from '@setu-ts/common';
import { stringFlag, type ParsedArgs } from '../args.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE, VERSION } from '../constants.ts';
import { gatherFacts, type ProjectFacts } from '../agents/facts.ts';
import { renderBrief, renderWorkspaceRoot } from '../agents/render.ts';
import { briefSection, spliceBrief } from '../agents/brief-file.ts';
import { cardWarnings } from '../agents/card-presence.ts';
import { detectProject } from '../utils/project-detector.ts';
import {
  dirName,
  joinPath,
  resolveDir,
  writeFiles,
  assertInsideProject,
  readExistingText,
  type GeneratedFile,
} from '../utils/file-writer.ts';
import { interruptionMessage } from '../utils/interruption.ts';
import { escapeName } from '../utils/names.ts';
import { memberPath } from '../utils/member-path.ts';
import { assertAgentWorkspaceOwnership } from '../utils/agent-workspace-ownership.ts';
import {
  readWorkspaceManifest,
  WORKSPACE_MANIFEST,
  MEMBERS_DIR,
  type WorkspaceManifest,
} from '../workspace/manifest.ts';

/** The same dependencies used when new invokes this writer after scaffolding. */
export interface IAgentsDependencies {
  readonly fs: IFileSystem;
  readonly cwd: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly interrupt?: AbortSignal;
}

async function existingBrief(fs: IFileSystem, path: string): Promise<string> {
  return (await readExistingText(fs, path)) ?? '';
}

async function agentWorkspace(
  fs: IFileSystem,
  dir: string,
): Promise<WorkspaceManifest | undefined> {
  // Keep the canonical parser, but give it the bounded, regular-file-only reader.
  const read = await readWorkspaceManifest(
    {
      ...fs,
      readFile: async (path) => new TextEncoder().encode(await readExistingText(fs, path)),
    },
    dir,
  );
  return read.ok ? read.manifest : undefined;
}

/** Render all affected files before touching any of them. */
export async function runAgentsCommand(
  args: ParsedArgs,
  deps: IAgentsDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log('Usage: setu agents [--check] [--dir <path>] [--dry-run]');
    deps.log('  --check     Refuse missing or stale sections, writing nothing');
    deps.log('  --dir <path> Operate on this project or workspace');
    deps.log('  --dry-run   Print the paths that would be written');
    return EXIT_OK;
  }
  if (args.flags['check'] === true && args.flags['dry-run'] === true) {
    deps.error('--check cannot be combined with --dry-run.');
    return EXIT_USAGE;
  }
  if (args.flags['dir'] !== undefined && typeof args.flags['dir'] !== 'string') {
    deps.error('--dir requires a path.');
    return EXIT_USAGE;
  }
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  try {
    // Like installSearchDirs, only a manifest listing this exact project can
    // authorize adopting an ancestor. No other ancestor manifest is inspected.
    let root = dir;
    let workspaceRoot: string | undefined;
    let workspace: WorkspaceManifest | undefined;
    for (let current = dir; ; current = dirName(current)) {
      const candidate = await agentWorkspace(deps.fs, current);
      if (
        candidate !== undefined &&
        (current === dir ||
          candidate.members.some(
            (member) => memberPath(joinPath(current, MEMBERS_DIR, member.name)) === memberPath(dir),
          ))
      ) {
        workspaceRoot = current;
        workspace = candidate;
        break;
      }
      if (dirName(current) === current || dirName(current) === '') break;
    }
    const briefs: { dir: string; section: string; facts?: ProjectFacts }[] = [];
    if (workspaceRoot !== undefined && workspace !== undefined) {
      await assertAgentWorkspaceOwnership(deps.fs, [
        workspaceRoot,
        ...workspace.members.map((member) => joinPath(workspaceRoot, MEMBERS_DIR, member.name)),
      ]);
      root = workspaceRoot;
      briefs.push({ dir: root, section: renderWorkspaceRoot(workspace, VERSION) });
      for (const member of workspace.members) {
        const memberDir = joinPath(root, 'apps', member.name);
        const facts = await gatherFacts(deps.fs, memberDir);
        briefs.push({ dir: memberDir, section: renderBrief(facts, true), facts });
      }
    } else {
      const project = await detectProject(deps.fs, dir);
      if (project.kind === 'workspace-root')
        throw new Error(`Cannot read ${joinPath(dir, WORKSPACE_MANIFEST)}: invalid workspace`);
      if (project.kind === 'none') {
        deps.error(
          `${escapeName(dir)} holds no Setu-TS project manifest; run inside a project or pass --dir.`,
        );
        return EXIT_USAGE;
      }
      const facts = await gatherFacts(deps.fs, dir);
      briefs.push({ dir, section: renderBrief(facts), facts });
    }
    const files: GeneratedFile[] = [];
    const stale: string[] = [];
    for (const brief of briefs) {
      const path = joinPath(brief.dir, 'AGENTS.md');
      await assertInsideProject(deps.fs, root, path);
      const before = await existingBrief(deps.fs, path);
      try {
        const range = briefSection(before);
        if (range === undefined || before.slice(range.start, range.end) !== brief.section)
          stale.push(path);
        files.push({ path, contents: spliceBrief(before, brief.section), managed: true });
      } catch (cause) {
        throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
        });
      }
    }
    if (args.flags['check'] === true) {
      for (const path of stale)
        deps.error(`${escapeName(path)}: missing or stale setu agents section`);
      return stale.length === 0 ? EXIT_OK : EXIT_ERROR;
    }
    if (args.flags['dry-run'] === true) {
      for (const file of files) deps.log(`would write ${escapeName(file.path)}`);
      return EXIT_OK;
    }
    const outcomes = await writeFiles(deps.fs, files, {
      root,
      ...(deps.interrupt === undefined ? {} : { signal: deps.interrupt }),
    });
    for (const result of outcomes) deps.log(`${result.outcome} ${escapeName(result.path)}`);
    for (const brief of briefs) {
      if (brief.facts === undefined) continue;
      for (const warning of await cardWarnings(
        deps.fs,
        brief.dir,
        brief.facts.installed,
        workspaceRoot,
      ))
        deps.error(escapeName(warning));
    }
    return EXIT_OK;
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    deps.error(interrupted ?? escapeName(cause instanceof Error ? cause.message : String(cause)));
    return interrupted === undefined ? EXIT_ERROR : EXIT_INTERRUPTED;
  }
}
