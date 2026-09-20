/**
 * Subprocess test for the M98b demo: the script must pair, read verified
 * DTOs, revoke, prove reads are refused, and prove the application still
 * serves — WITHOUT ever printing the session ID/key or environment.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('inspect-local-diagnostics demo', () => {
  it('runs the loopback consumer exercise end-to-end and leaks no credential', async () => {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-read',
        '--allow-env',
        '--allow-net=127.0.0.1',
        'scripts/inspect-local-diagnostics.ts',
      ],
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code, stdout, stderr } = await command.output();
    const output = new TextDecoder().decode(stdout);
    const errors = new TextDecoder().decode(stderr);
    expect(code).toEqual(0);
    // Deno.serve prints its startup banner to stderr; that is the only
    // line stderr may carry (it names the port, never a credential).
    const errorLines = errors.trim().split('\n').filter((line) => line.length > 0);
    expect(errorLines.length).toBeLessThanOrEqual(1);
    for (const line of errorLines) {
      expect(line).toMatch(/^Listening on http:\/\/127\.0\.0\.1:\d+\/$/);
    }

    // The evidence lines, in order.
    expect(output).toContain('paired and read snapshot: state=running');
    expect(output).toMatch(/read [1-9]\d* event\(s\)/);
    expect(output).toContain('post-revoke read refused: true');
    expect(output).toContain('application still serves: GET /items -> 200');

    // No credential material anywhere in the output: the script generates
    // a random 32-hex session id and 32-byte key purely in memory.
    expect(output).not.toMatch(/[0-9a-f]{32}/);
  });
});
