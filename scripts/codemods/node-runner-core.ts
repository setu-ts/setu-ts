/** Pure selection, execution and report formatting for the Node runner. @module */
export interface NodeTestResult {
  code: number;
  rows: readonly string[];
}

/** Accept a member path or its unambiguous basename; refuse unknown selections. */
export function selectMembers(
  workspace: readonly string[],
  selection: readonly string[],
): string[] {
  if (selection.length === 0) return [...workspace];
  return [
    ...new Set(selection.map((name) => {
      const member = workspace.find((path) =>
        path.replace(/^\.\//, '') === name.replace(/^\.\//, '') || path.split('/').pop() === name
      );
      if (member === undefined) throw new Error(`Unknown workspace member: ${name}`);
      return member;
    })),
  ];
}

/** Iterate every member and the tooling target; one failed run fails the combined result. */
export async function runTargets(
  members: readonly string[],
  execute: (member: string) => Promise<NodeTestResult>,
): Promise<NodeTestResult> {
  const rows: string[] = [];
  let code = 0;
  for (const member of [...members, 'tooling']) {
    const result = await execute(member);
    if (result.code !== 0) code = 1;
    rows.push(...result.rows);
  }
  return { code, rows };
}

/** Format every source row; callers reject missing reports instead of omitting a failed member. */
export function coverageRows(
  summary: Record<string, {
    branches: { pct: number };
    functions: { pct: number };
    lines: { pct: number };
  }>,
  root: string,
): string[] {
  return Object.entries(summary).filter(([path]) => path !== 'total').map(([path, row]) =>
    `| ${
      path.replace(root + '/', '')
    } | ${row.branches.pct} | ${row.functions.pct} | ${row.lines.pct} |`
  );
}

