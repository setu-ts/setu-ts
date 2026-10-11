/** Root tooling coverage, forwarding lock flags to the test process rather than the reporter. @module */
if (import.meta.main) {
  await Deno.remove('coverage', { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  const tests = await new Deno.Command('deno', {
    args: [
      'run',
      '--allow-read',
      '--allow-run=deno',
      'scripts/test-partition.ts',
      '--root-only',
      '--coverage',
      ...Deno.args,
    ],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  const coverage = await new Deno.Command('deno', {
    args: ['run', '--allow-run=deno', 'scripts/script-coverage.ts', 'coverage'],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  Deno.exit(tests.code || coverage.code);
}
