import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const WORKFLOW = '.github/workflows/drift.yml';

async function readWorkflow(): Promise<string> {
  return await readFile(WORKFLOW, 'utf8');
}

/** The text of one named step, up to the blank line that ends it. */
function stepOf(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}\n`);
  if (start === -1) throw new Error(`No step named ${name}`);
  return text.slice(start, text.indexOf('\n\n', start));
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
  it('checks out develop, not the default branch', async () => {
    // Issue #507: a scheduled run checks out `main`, the last release, so the
    // gates reported a test race develop had already fixed. The one checkout
    // in this workflow must name develop explicitly.
    const text = await readWorkflow();
    const checkouts = text.match(/uses:\s*actions\/checkout@/g) ?? [];
    expect(checkouts).toHaveLength(1);
    const step = text.slice(
      text.indexOf('uses: actions/checkout@'),
      text.indexOf('\n\n', text.indexOf('uses: actions/checkout@')),
    );
    expect(step).toMatch(/^\s+ref: develop$/m);
  });

  it('uses only tools the runner image actually provides', async () => {
    // ripgrep is NOT installed on ubuntu-24.04. `rg --files` exited 127 before
    // any resolution ran, and the report step attributed that to drift.
    expect(await readWorkflow()).not.toMatch(/(^|\s)rg\s/m);
  });

  it('resolves every declared range fresh, then installs that lock frozen', async () => {
    // M111e3: one pnpm lock covers every package, app and tooling dependency, so
    // resolving the declared ranges IS the whole graph the gates walk. The
    // committed lock is kept for the report before it is removed, and the
    // fresh lock is installed frozen so the gates run against exactly what the
    // report describes rather than a second, unreported resolution.
    const step = stepOf(await readWorkflow(), 'Resolve every declared range fresh');
    expect(step).toContain('id: resolve');
    expect(step).toContain('continue-on-error: true');
    const order = [
      'cp pnpm-lock.yaml "$RUNNER_TEMP/pnpm-lock.committed.yaml"',
      'rm pnpm-lock.yaml',
      'pnpm install --lockfile-only',
      'pnpm install --frozen-lockfile',
    ];
    let previous = -1;
    for (const command of order) {
      const index = step.indexOf(command);
      expect(index, command).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it('reports drift by comparing the committed lock with the fresh one', async () => {
    const step = stepOf(await readWorkflow(), 'Attribute drift and summarize gates');
    // `--silent`: pnpm's own run banner would otherwise land in the issue body.
    expect(step).toMatch(
      /pnpm --silent run dependency:drift "\$RUNNER_TEMP\/pnpm-lock\.committed\.yaml" \\\n\s+pnpm-lock\.yaml > "\$report"/,
    );
  });

  it('never tests a resolution other than the fresh one', async () => {
    const text = await readWorkflow();
    // `DENO_FLAGS` was inert and made the gates test the COMMITTED lock while
    // their step names claimed the fresh graph (issue #216); an unfrozen
    // install would resolve a second graph the report never describes.
    expect(text).not.toMatch(/^\s*DENO_FLAGS:/m);
    expect(text).not.toContain('--no-frozen-lockfile');
    expect(text).not.toContain('dependency-drift.lock');
  });

  it('keeps the resolve step gating the four reported gates', async () => {
    const text = await readWorkflow();
    // Every gate is conditioned on a successful resolve; without that a failed
    // resolution would report four misleading `success` rows beneath it.
    const guards = text.match(/if: always\(\) && steps\.resolve\.outcome == 'success'\n/g);
    expect(guards?.length).toBe(4);
    for (const name of ['Format check', 'Lint', 'Type check against fresh resolution']) {
      expect(stepOf(text, name)).toContain("if: always() && steps.resolve.outcome == 'success'");
    }
  });
});
