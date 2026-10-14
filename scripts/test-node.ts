// deno-lint-ignore-file no-console -- repository test runner
/** Per-member Node runs bound memory use and enforce coverage in each package's own suite. */
import { coverageRows, runTargets, selectMembers } from './codemods/node-runner-core.ts';
export { coverageRows, runTargets, selectMembers } from './codemods/node-runner-core.ts';

if (import.meta.main) {
  const coverage = Deno.args.includes('--coverage');
  const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as { workspace: string[] };
  const selection = Deno.args.filter((arg) => arg !== '--coverage');
  const members = selectMembers(manifest.workspace, selection);
  const result = await runTargets(members, async (member) => {
    const target = member.split('/').pop()!;
    await Deno.mkdir(`coverage-node/${target}`, { recursive: true });
    const report = `coverage-node/${target}/coverage-summary.json`;
    if (coverage) {
      await Deno.remove(report).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
    const output = await new Deno.Command('pnpm', {
      args: ['exec', 'vitest', 'run', ...(coverage ? ['--coverage'] : [])],
      env: { SETU_TEST_MEMBER: member, NODE_OPTIONS: '--max-old-space-size=4096' },
      stdout: 'inherit',
      stderr: 'inherit',
    }).output();
    if (!coverage) return { code: output.code, rows: [] };
    try {
      const summary = JSON.parse(await Deno.readTextFile(report));
      const rows = coverageRows(summary, Deno.cwd());
      if (rows.length === 0) throw new Error('empty per-file coverage report');
      return { code: output.code, rows };
    } catch (error) {
      console.error(`${target}: missing or invalid coverage report: ${error}`);
      return { code: 1, rows: [] };
    }
  });
  if (coverage) {
    console.log(
      [
        '| File | Branch % | Function % | Line % |',
        '| --- | --- | --- | --- |',
        ...result.rows,
      ].join('\n'),
    );
  }
  Deno.exit(result.code);
}
