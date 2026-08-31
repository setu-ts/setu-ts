import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';

const WORKFLOW = '.github/workflows/drift.yml';

async function readWorkflow(): Promise<string> {
  return await Deno.readTextFile(WORKFLOW);
}

/**
 * The dependency-drift job is the one gate whose own failure looks like its
 * success: the job carries `continue-on-error: true`, so a broken step still
 * reports the run green while filing a "Dependency drift detected" issue that
 * has checked nothing. Issue #216 was exactly that — the very first scheduled
 * run exited 127 on a missing `rg`, and the workflow never once resolved a
 * dependency. These pins are the M53 precedent applied here: assert the wiring,
 * because a regression is a one-word edit that CI reports as passing.
 */
describe('dependency drift gate configuration', () => {
  it('lists sources with a tool the runner image actually provides', async () => {
    const text = await readWorkflow();
    // ripgrep is NOT installed on ubuntu-24.04. `rg --files` exited 127 before
    // any resolution ran, and the report step attributed that to drift.
    expect(text).not.toMatch(/(^|\s)rg\s/m);
    expect(text).toContain(
      `git ls-files -- 'packages/*.ts' 'test/*.ts' 'scripts/*.ts'`,
    );
  });

  it('passes the fresh lock to the gates that read one, as real flags', async () => {
    const text = await readWorkflow();
    // `DENO_FLAGS` is not a Deno environment variable — Deno ignores it, so
    // setting it made every gate run against the COMMITTED deno.lock while its
    // step name claimed the fresh graph. A green table proved nothing.
    // Matched as an env KEY, not as a substring: the workflow's own comment
    // explains why the variable is inert and must not trip this pin.
    expect(text).not.toMatch(/^\s*DENO_FLAGS:/m);
    for (const task of ['check', 'test']) {
      expect(text).toContain(
        `deno task ${task} --lock="$RUNNER_TEMP/dependency-drift.lock" --frozen`,
      );
    }
  });

  it('does not claim fresh resolution for gates that cannot read a lock', async () => {
    const text = await readWorkflow();
    // `deno fmt` and `deno lint` accept neither --lock nor --frozen, so a step
    // named "… against fresh resolution" running one of them is a false claim
    // and passing the flags would be a hard error.
    // Pinned positively and with the trailing newline, so ANY rename fails --
    // not merely a re-add of the one phrasing this PR removed. The false name
    // is one of the three defects fixed here, so it needs its own pin.
    expect(text).toContain('- name: Format check\n');
    expect(text).toContain('- name: Lint\n');
    expect(text).toContain('run: deno task fmt:check\n');
    expect(text).toContain('run: deno task lint\n');
    // Both flags, not just --lock: `deno fmt --check --frozen` and
    // `deno lint --frozen` each abort with "unexpected argument '--frozen'
    // found", so a --frozen-only regression breaks the job just as hard.
    expect(text).not.toMatch(/deno task (fmt:check|lint) .*--(?:lock|frozen)/);
  });

  it('keeps the resolve step gating the four reported gates', async () => {
    const text = await readWorkflow();
    // Every gate is conditioned on a successful resolve; without that a failed
    // resolution would report four misleading `success` rows beneath it.
    const guards = text.match(/if: always\(\) && steps\.resolve\.outcome == 'success'/g);
    expect(guards?.length).toBe(4);
  });
});
