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
  /** One Vitest shard, with partial coverage recorded as a blob. */
  shard?: string;
  /** Merge a member's blobs and enforce its complete coverage. */
  merge?: boolean;
}

/** Read `--coverage`, `--no-tooling` and repeated `--skip <member>`; anything else is a member. */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const args: RunnerArgs = { coverage: false, tooling: true, selection: [], skip: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--coverage') args.coverage = true;
    else if (arg === '--merge') args.merge = true;
    else if (arg === '--shard') {
      const value = argv[++index];
      if (
        value === undefined ||
        !/^[1-8]\/[1-8]$/.test(value) ||
        Number(value[0]) > Number(value[2])
      )
        throw new Error('--shard requires i/n with integers 1 ≤ i ≤ n ≤ 8');
      args.shard = value;
    } else if (arg === '--no-tooling') args.tooling = false;
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

/** Validate the resolved member selection before spawning any test process. */
export function validateRunnerArgs(args: RunnerArgs, members: readonly string[]): void {
  if (args.shard === undefined && !args.merge) return;
  if (args.shard !== undefined && args.merge)
    throw new Error('--shard and --merge are mutually exclusive');
  if (!args.coverage) throw new Error('--shard and --merge require --coverage');
  if (members.length !== 1 || args.selection.length === 0)
    throw new Error('--shard and --merge require exactly one selected member');
  if (args.tooling)
    throw new Error('--shard and --merge refuse the tooling target; pass --no-tooling');
}

/** Build the Vitest invocation; shard output directories contain blobs only. */
export function vitestArgs(args: RunnerArgs, target: string): string[] {
  return [
    'exec',
    'vitest',
    'run',
    ...(args.merge ? [`--merge-reports=.vitest-reports/${target}`] : []),
    ...(args.coverage ? ['--coverage'] : []),
    ...(args.shard === undefined
      ? []
      : [
          `--shard=${args.shard}`,
          '--reporter=blob',
          // The blob test reporter does not suppress Vitest's partial coverage table.
          '--coverage.reporter=json-summary',
          '--coverage.reporter=json',
          // Its own subdirectory: Vitest empties the reports directory first, and
          // shards sharing one checkout (ci:local) must not empty each other's.
          `--coverage.reportsDirectory=coverage-node/${target}/shard-${args.shard.split('/')[0]}`,
          `--outputFile.blob=.vitest-reports/${target}/blob-${args.shard.split('/')[0]}.json`,
        ]),
  ];
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
    if (result.code !== 0) code = result.code;
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
