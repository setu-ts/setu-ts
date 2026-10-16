import { run as runProcess } from './lib/run.ts';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { isNotFound } from './lib/run.ts';
/* eslint-disable no-console -- repository test runner */
/** Per-member Node runs bound memory use and enforce coverage in each package's own suite. */
import { workspaceMembers } from './lib/workspace.ts';
import {
  coverageRows,
  parseRunnerArgs,
  runTargets,
  selectMembers,
} from './codemods/node-runner-core.ts';
export { coverageRows, runTargets, selectMembers } from './codemods/node-runner-core.ts';

if (import.meta.main) {
  await (async () => {
    const args = parseRunnerArgs(process.argv.slice(2));
    const coverage = args.coverage;
    const workspace = await workspaceMembers();
    const members = selectMembers(workspace, args.selection, args.skip);
    const result = await runTargets(
      members,
      async (member) => {
        const target = member.split('/').pop()!;
        await mkdir(`coverage-node/${target}`, { recursive: true });
        const report = `coverage-node/${target}/coverage-summary.json`;
        if (coverage) {
          await rm(report).catch((error) => {
            if (!isNotFound(error)) throw error;
          });
        }
        const output = await runProcess(
          'pnpm',
          ['exec', 'vitest', 'run', ...(coverage ? ['--coverage'] : [])],
          {
            env: {
              ...process.env,
              ...{ SETU_TEST_MEMBER: member, NODE_OPTIONS: '--max-old-space-size=4096' },
            },
            inherit: true,
          },
        );
        if (!coverage) return { code: output.code, rows: [] };
        try {
          const summary = JSON.parse(await readFile(report, 'utf8'));
          const rows = coverageRows(summary, process.cwd());
          if (rows.length === 0) throw new Error('empty per-file coverage report');
          return { code: output.code, rows };
        } catch (error) {
          console.error(`${target}: missing or invalid coverage report: ${error}`);
          return { code: 1, rows: [] };
        }
      },
      args.tooling,
    );
    if (coverage) {
      console.log(
        [
          '| File | Branch % | Function % | Line % |',
          '| --- | --- | --- | --- |',
          ...result.rows,
        ].join('\n'),
      );
    }
    process.exitCode = result.code;
    return;
  })();
}
