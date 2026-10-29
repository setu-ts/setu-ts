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
  validateRunnerArgs,
  vitestArgs,
} from './codemods/node-runner-core.ts';
export { coverageRows, runTargets, selectMembers } from './codemods/node-runner-core.ts';

if (import.meta.main) {
  await (async () => {
    let args;
    let members;
    try {
      args = parseRunnerArgs(process.argv.slice(2));
      members = selectMembers(await workspaceMembers(), args.selection, args.skip);
      validateRunnerArgs(args, members);
    } catch (error) {
      console.error(String(error));
      process.exitCode = 2;
      return;
    }
    const coverage = args.coverage;
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
        const env: Record<string, string | undefined> = {
          ...process.env,
          SETU_TEST_MEMBER: member,
          NODE_OPTIONS: '--max-old-space-size=4096',
        };
        // A merge must always enforce thresholds, even from a shard-marked parent.
        delete env.SETU_TEST_SHARD;
        if (args.shard !== undefined) env.SETU_TEST_SHARD = '1';
        const output = await runProcess('pnpm', vitestArgs(args, target), {
          env,
          inherit: true,
        });
        if (!coverage || args.shard !== undefined) return { code: output.code, rows: [] };
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
    if (coverage && args.shard === undefined) {
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
