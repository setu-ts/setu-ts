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
  reportDryRunPlan,
  assertInsideProject,
  readExistingText,
  type GeneratedFile,
  type ICliFileSystem,
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
  readonly fs: ICliFileSystem;
  readonly cwd: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  /**
   * The shell's logical working directory, when it is absolute and resolves to
   * the same place as the physical `cwd`. Used ONLY to refuse a write through a
   * symlinked workspace member; it never authorizes one.
   */
  readonly logicalCwd?: string;
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

/**
 * Finds a workspace manifest that lists a LOGICAL path as a member.
 *
 * The physical walk cannot see a workspace from inside a symlinked member: the
 * manifest is at the child's logical ancestor, while every filesystem call
 * resolves to the link target. This walk answers one question only — is this
 * logical target a member of a workspace? — and its answer is a refusal.
 *
 * @param fs - The filesystem to read manifests through
 * @param logicalCwd - The shell's verified logical working directory
 * @param dir - The `--dir` value, resolved against the logical directory
 * @returns The refusal message, or undefined when no manifest lists the target
 */
async function symlinkedMemberRefusal(
  fs: IFileSystem,
  logicalCwd: string,
  dir: string | undefined,
): Promise<string | undefined> {
  const logicalDir = resolveDir(logicalCwd, dir);
  for (let current = logicalDir; ; current = dirName(current)) {
    const candidate = await agentWorkspace(fs, current);
    if (
      candidate !== undefined &&
      candidate.members.some(
        (member) =>
          memberPath(joinPath(current, MEMBERS_DIR, member.name)) === memberPath(logicalDir),
      )
    )
      return (
        `${logicalDir} is a symlinked member of the workspace at ${current}; Setu will not ` +
        `write through links inside a workspace. Replace the link with the directory it points ` +
        `at, then run setu agents from ${current}.`
      );
    if (dirName(current) === current || dirName(current) === '') return undefined;
  }
}

/**
 * The planned briefs whose bytes differ from what is on disk.
 *
 * A brief whose spliced bytes match the file exactly is not rewritten; the real
 * run reports it `unchanged`, which is what the file's write outcome would say.
 */
function changedBriefs(
  files: readonly GeneratedFile[],
  unchanged: ReadonlySet<string>,
): readonly GeneratedFile[] {
  return files.filter((file) => !unchanged.has(file.path));
}

/**
 * The changed briefs whose target the invoking user cannot write.
 *
 * Advisory: the Node writer maps a permission failure after this probe too. A
 * filesystem without `canWrite` (the fakes) skips the preflight.
 */
async function unwritableBriefs(
  fs: ICliFileSystem,
  files: readonly GeneratedFile[],
): Promise<readonly string[]> {
  if (fs.canWrite === undefined) return [];
  const refused: string[] = [];
  for (const file of files) if (!(await fs.canWrite(file.path))) refused.push(file.path);
  return refused;
}

/** Render all affected files before touching any of them. */
export async function runAgentsCommand(
  args: ParsedArgs,
  deps: IAgentsDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log('Usage: setu agents [--check] [--dir <path>] [--dry-run]');
    deps.log('  --check     Refuse missing or stale sections, writing nothing');
    deps.log('  --strict    With --check, also refuse a brief whose agent cards are not installed');
    deps.log('  --dir <path> Operate on this project or workspace');
    deps.log('  --dry-run   Print the paths that would be written');
    return EXIT_OK;
  }
  if (args.flags['check'] === true && args.flags['dry-run'] === true) {
    deps.error('--check cannot be combined with --dry-run.');
    return EXIT_USAGE;
  }
  // `--check` deliberately answers without an install (C1): the card probe is
  // opt-in, and naming it without the mode it extends is a usage error rather
  // than a silently ignored flag.
  if (args.flags['strict'] === true && args.flags['check'] !== true) {
    deps.error('--strict requires --check.');
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
    // The physical walk cannot find a workspace from inside a symlinked member.
    // When the shell's logical path differs, ask whether that path is a member:
    // a yes refuses in every mode and never authorizes a write.
    if (
      workspaceRoot === undefined &&
      deps.logicalCwd !== undefined &&
      deps.logicalCwd !== deps.cwd
    ) {
      const refusal = await symlinkedMemberRefusal(
        deps.fs,
        deps.logicalCwd,
        stringFlag(args.flags, 'dir'),
      );
      if (refusal !== undefined) throw new Error(refusal);
    }
    const briefs: { dir: string; section: string; facts?: ProjectFacts }[] = [];
    if (workspaceRoot !== undefined && workspace !== undefined) {
      // --check writes nothing, so a tree other users can rearrange is no risk to it.
      // --dry-run keeps the check, so it never promises a plan the real run refuses.
      if (args.flags['check'] !== true)
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
    const unchanged = new Set<string>();
    const stale: string[] = [];
    for (const brief of briefs) {
      const path = joinPath(brief.dir, 'AGENTS.md');
      await assertInsideProject(deps.fs, root, path);
      const before = await existingBrief(deps.fs, path);
      try {
        const range = briefSection(before);
        if (range === undefined || before.slice(range.start, range.end) !== brief.section)
          stale.push(path);
        const contents = spliceBrief(before, brief.section);
        if (contents === before) unchanged.add(path);
        files.push({ path, contents, managed: true });
      } catch (cause) {
        throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
        });
      }
    }
    if (args.flags['check'] === true) {
      for (const path of stale)
        deps.error(`${escapeName(path)}: missing or stale setu agents section`);
      let cardRefusals = 0;
      if (args.flags['strict'] === true) {
        for (const brief of briefs) {
          if (brief.facts === undefined) continue;
          const briefPath = joinPath(brief.dir, 'AGENTS.md');
          for (const warning of await cardWarnings(
            deps.fs,
            brief.dir,
            brief.facts.installed,
            workspaceRoot,
          )) {
            deps.error(`${escapeName(briefPath)}: ${escapeName(warning)}`);
            cardRefusals++;
          }
        }
      }
      return stale.length === 0 && cardRefusals === 0 ? EXIT_OK : EXIT_ERROR;
    }
    const changed = changedBriefs(files, unchanged);
    const refused = await unwritableBriefs(deps.fs, changed);
    if (args.flags['dry-run'] === true) {
      if (refused.length > 0) {
        for (const path of refused)
          deps.error(`WOULD REFUSE: ${escapeName(path)} is not writable by you`);
        return EXIT_ERROR;
      }
      return await reportDryRunPlan(deps, files);
    }
    // Before the first byte: a partial batch is worse than a named refusal.
    if (refused.length > 0) {
      for (const path of refused)
        deps.error(`${escapeName(path)}: not writable by you; nothing was written`);
      return EXIT_ERROR;
    }
    const outcomes =
      changed.length === 0
        ? []
        : await writeFiles(deps.fs, changed, {
            root,
            ...(deps.interrupt === undefined ? {} : { signal: deps.interrupt }),
          });
    const outcomeFor = new Map(outcomes.map((result) => [result.path, result.outcome]));
    for (const file of files)
      deps.log(`${outcomeFor.get(file.path) ?? 'unchanged'} ${escapeName(file.path)}`);
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
