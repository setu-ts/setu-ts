// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Coverage report wrapper.
 *
 * `deno coverage` exits non-zero when no source files were covered, which is
 * the expected state while packages are empty stubs (Milestone 0). This
 * wrapper treats exactly that case as a warning and every other failure as a
 * hard error, so `deno task test:coverage` stays honest once real code lands.
 */
const command = new Deno.Command('deno', {
  args: ['coverage', 'coverage'],
  stdout: 'inherit',
  stderr: 'piped',
});

const output = await command.output();
const stderr = new TextDecoder().decode(output.stderr);

if (!output.success) {
  if (stderr.includes('No covered files included in the report')) {
    console.warn(
      'No coverage data yet (package stubs only). ' +
        'This becomes a hard failure once implementation code exists.',
    );
    Deno.exit(0);
  }
  console.error(stderr);
  Deno.exit(output.code);
}
