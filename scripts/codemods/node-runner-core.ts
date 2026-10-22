/** Pure selection, execution and report formatting for the Node runner. @module */
export interface NodeTestResult {
  code: number;
  rows: readonly string[];
}

/** Parsed command line of the Node runner. */
export interface RunnerArgs {
  /** Measure coverage and enforce the per-file thresholds. */
  coverage: boolean;
  /** Run the root tooling target after the members (refused off by `--no-tooling`). */
  tooling: boolean;
  /** Members to run; empty means every workspace member. */
  selection: string[];
  /** Members to leave out — how CI gives each shard its own slice of the workspace. */
  skip: string[];
}

/** Read `--coverage`, `--no-tooling` and repeated `--skip <member>`; anything else is a member. */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const args: RunnerArgs = { coverage: false, tooling: true, selection: [], skip: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--coverage') args.coverage = true;
    else if (arg === '--no-tooling') args.tooling = false;
    else if (arg === '--skip') {
      const member = argv[++index];
      if (member === undefined || member.startsWith('--')) {
        throw new Error('--skip requires a workspace member');
      }
      args.skip.push(member);
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else args.selection.push(arg);
  }
  return args;
}

/**
 * Accept a member path or its unambiguous basename; refuse unknown selections.
 * A skipped name is resolved the same way, so a typo fails instead of silently
 * running the member it meant to exclude.
 */
export function selectMembers(
  workspace: readonly string[],
  selection: readonly string[],
  skip: readonly string[] = [],
): string[] {
  const resolve = (name: string): string => {
    const member = workspace.find(
      (path) =>
        path.replace(/^\.\//, '') === name.replace(/^\.\//, '') || path.split('/').pop() === name,
    );
    if (member === undefined) throw new Error(`Unknown workspace member: ${name}`);
    return member;
  };
  const skipped = new Set(skip.map(resolve));
  const chosen = selection.length === 0 ? [...workspace] : [...new Set(selection.map(resolve))];
  return chosen.filter((member) => !skipped.has(member));
}

/** Iterate every member and the tooling target; one failed run fails the combined result. */
export async function runTargets(
  members: readonly string[],
  execute: (member: string) => Promise<NodeTestResult>,
  tooling = true,
): Promise<NodeTestResult> {
  const rows: string[] = [];
  let code = 0;
  for (const member of tooling ? [...members, 'tooling'] : members) {
    const result = await execute(member);
    if (result.code !== 0) code = 1;
    rows.push(...result.rows);
  }
  return { code, rows };
}

/** Format every source row; callers reject missing reports instead of omitting a failed member. */
export function coverageRows(
  summary: Record<
    string,
    {
      branches: { pct: number };
      functions: { pct: number };
      lines: { pct: number };
    }
  >,
  root: string,
): string[] {
  return Object.entries(summary)
    .filter(([path]) => path !== 'total')
    .map(
      ([path, row]) =>
        `| ${path.replace(
          root + '/',
          '',
        )} | ${row.branches.pct} | ${row.functions.pct} | ${row.lines.pct} |`,
    );
}
