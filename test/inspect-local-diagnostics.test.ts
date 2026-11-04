/**
 * Subprocess test for the M98b demo: the script must pair, read verified
 * DTOs, revoke, prove reads are refused, and prove the application still
 * serves — WITHOUT ever printing the session ID/key or environment.
 */
import { describe, expect, it } from 'vitest';
import { run } from './node-helpers.ts';

describe('inspect-local-diagnostics demo', () => {
  it('runs the loopback consumer exercise end-to-end and leaks no credential', async () => {
    const deno = 'Deno' in globalThis;
    // `--frozen` with no package.json discovery resolves the lane lock exactly
    // as committed and never rewrites it. `--quiet` silences Deno's own
    // stderr — cold-cache Download/Initialize lines, warnings, and the
    // `Deno.serve` banner — while every write the script makes still lands.
    const args = deno
      ? [
          'run',
          '--config=test/deno-lane/lane.config.json',
          '--frozen',
          '--quiet',
          '--allow-read',
          '--allow-env',
          '--allow-net=127.0.0.1',
          'scripts/inspect-local-diagnostics.ts',
        ]
      : ['--import', './scripts/lib/source-register.ts', 'scripts/inspect-local-diagnostics.ts'];
    const { code, stdout, stderr } = await run(process.execPath, {
      args,
      ...(deno ? { env: { DENO_NO_PACKAGE_JSON: '1' } } : {}),
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    });
    const output = new TextDecoder().decode(stdout);
    const errors = new TextDecoder().decode(stderr);
    expect(code).toEqual(0);
    // On Node the listener prints its startup banner to stderr; that is the
    // only line stderr may carry (it names the port, never a credential).
    // On Deno that banner is the runtime's and `--quiet` removes it, so the
    // script's stderr must be empty.
    const errorLines = errors
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    expect(errorLines.length, errors).toBeLessThanOrEqual(deno ? 0 : 1);
    for (const line of errorLines) {
      expect(line).toMatch(/^Listening on http:\/\/127\.0\.0\.1:\d+\/$/);
    }

    // The evidence lines, in order.
    expect(output).toContain('paired and read snapshot: state=running');
    expect(output).toMatch(/renewed session: before=\d+ after=\d+ cap=\d+/);
    expect(output).toMatch(/read [1-9]\d* event\(s\)/);
    expect(output).toContain('post-revoke read refused: true');
    expect(output).toContain('application still serves: GET /items -> 200');

    // No credential material anywhere in the output: the script generates
    // a random 32-hex session id and 32-byte key purely in memory.
    expect(output).not.toMatch(/[0-9a-f]{32}/);
  });
});
