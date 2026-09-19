/**
 * Every `actions/checkout` in every workflow declares a credential decision.
 *
 * `actions/checkout` writes GITHUB_TOKEN into the local git config by default,
 * so anything a job runs afterwards can read it — and these workflows install,
 * resolve, and in places dynamically import third-party code. Issue #340
 * reviewed all eight checkouts one at a time; none performs a networked git
 * operation (the only git commands anywhere in the gates are `git show`,
 * `git rev-parse` and `git ls-files`, which are local object reads), so all
 * eight drop the credential.
 *
 * This gate exists because the default is the unsafe direction: a NEW job added
 * with a bare `- uses: actions/checkout@v4` inherits credential persistence
 * silently, and no other gate in this repository can see it — a workflow file
 * is invisible to `deno fmt`, `deno lint` and `deno check` alike.
 *
 * A job that genuinely needs an authenticated git operation is added to
 * {@linkcode CREDENTIALED_STEPS} with the operation named. That list is
 * deliberately an allowlist rather than a "comment present" check: a reviewer
 * reading one file sees every exception, and adding one is a visible diff.
 *
 * @module
 */

import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';

const WORKFLOW_DIR = '.github/workflows';

/**
 * Checkout steps that keep credential persistence, each with the git operation
 * that requires it.
 *
 * Empty today, and that is the finding rather than an oversight: no job in this
 * repository performs a networked git operation. `release.yml` does push a
 * release, but it takes its token explicitly through `GH_TOKEN` instead — see
 * the comment on its own checkout step.
 */
const CREDENTIALED_STEPS: ReadonlyMap<string, string> = new Map();

/** One `actions/checkout` step, located for reporting. */
interface CheckoutStep {
  /** Workflow file name, e.g. `ci.yml`. */
  readonly workflow: string;
  /** 1-indexed line of the `- uses: actions/checkout@…` line. */
  readonly line: number;
  /** The step's text, from its `- uses:` line up to the next step or job. */
  readonly body: string;
}

/**
 * Every `actions/checkout` step across every workflow.
 *
 * A step runs to the next line at or above its own indentation that starts a
 * new list item or a new mapping key — which is what bounds `body` to this step
 * rather than letting a later step's settings satisfy the assertion.
 */
async function checkoutSteps(): Promise<readonly CheckoutStep[]> {
  const steps: CheckoutStep[] = [];
  for await (const entry of Deno.readDir(WORKFLOW_DIR)) {
    if (!entry.isFile || !entry.name.endsWith('.yml')) continue;
    const lines = (await Deno.readTextFile(`${WORKFLOW_DIR}/${entry.name}`)).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^(\s*)- uses: actions\/checkout@/.exec(lines[index] ?? '');
      if (match === null) continue;
      const indent = (match[1] ?? '').length;
      let end = index + 1;
      while (end < lines.length) {
        const line = lines[end] ?? '';
        const leading = line.length - line.trimStart().length;
        // A blank line does not end a step; a line at or left of the `-` that
        // is not a continuation of it does.
        if (line.trim() !== '' && leading <= indent) break;
        end += 1;
      }
      steps.push({
        workflow: entry.name,
        line: index + 1,
        body: lines.slice(index, end).join('\n'),
      });
    }
  }
  return steps.sort((a, b) =>
    a.workflow === b.workflow ? a.line - b.line : a.workflow.localeCompare(b.workflow)
  );
}

describe('workflow checkout credentials', () => {
  it('finds every checkout step', async () => {
    const steps = await checkoutSteps();
    // A vacuity guard: a scanner that matched nothing would satisfy every
    // assertion below. The count is deliberately a floor rather than an
    // equality — adding a job should not fail this line, it should fail the
    // decision assertion that follows.
    expect(steps.length).toBeGreaterThanOrEqual(8);
    // An array rather than a Set: `@std/expect`'s `toContain` reports a Set as
    // not containing a member it does contain, so a Set here would fail for a
    // reason unrelated to the workflows.
    const workflows = [...new Set(steps.map((step) => step.workflow))];
    for (const workflow of ['ci.yml', 'compat.yml', 'drift.yml', 'release.yml', 'website.yml']) {
      expect(workflows).toContain(workflow);
    }
  });

  it('drops the persisted credential everywhere it is not required', async () => {
    const undecided: string[] = [];
    for (const step of await checkoutSteps()) {
      const identifier = `${step.workflow}:${step.line}`;
      if (CREDENTIALED_STEPS.has(identifier)) {
        // An allowlisted step must NOT silently have been fixed: if it now sets
        // `false`, the allowlist entry is stale and should be removed.
        expect(step.body).not.toContain('persist-credentials: false');
        continue;
      }
      if (!step.body.includes('persist-credentials: false')) {
        undecided.push(identifier);
      }
    }
    expect(undecided).toEqual([]);
  });

  it('reads each step in isolation', async () => {
    // The scanner's bound is the load-bearing part: without it, one job's
    // `persist-credentials: false` would satisfy the assertion for every
    // checkout after it in the same file. `ci.yml` has six, so a step body that
    // ran to the end of the file would make five of them vacuous.
    const steps = (await checkoutSteps()).filter((step) => step.workflow === 'ci.yml');
    expect(steps.length).toBe(6);
    for (const step of steps) {
      expect(step.body).toContain('- uses: actions/checkout@');
      // Exactly one checkout per body, and no later step folded in.
      expect(step.body.match(/- uses: actions\/checkout@/g)?.length).toBe(1);
      expect(step.body).not.toContain('denoland/setup-deno');
    }
  });
});
