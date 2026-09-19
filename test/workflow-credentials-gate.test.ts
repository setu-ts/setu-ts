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
 * silently, and no other gate in this repository can see it — a workflow file is
 * invisible to `deno fmt`, `deno lint` and `deno check` alike.
 *
 * ## The scanner fails CLOSED, deliberately
 *
 * The first version of this gate failed OPEN in three ways, all found in review
 * of PR #342 and all reproduced before being fixed: it read only `.yml` and so
 * could not see a `.yaml` workflow at all; it anchored on `- uses:` and so could
 * not see the commoner `- name:` / `uses:` step shape at all; and it tested the
 * decision with a raw `body.includes('persist-credentials: false')`, which a
 * COMMENT mentioning the setting satisfied. A gate whose whole argument is "the
 * default is unsafe and nothing else can see it" cannot itself be the thing that
 * passes by accident.
 *
 * So comments are stripped before anything is matched, and the decision must be
 * a real `persist-credentials: false` mapping line. Every unrecognised form —
 * flow style (`with: { persist-credentials: false }`), a quoted `'false'` —
 * therefore FAILS rather than passing, which is the safe direction: a false
 * failure names the step and is fixed by writing the setting plainly, whereas a
 * false pass is a credential in reach of third-party code and silent.
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

/** Both extensions GitHub accepts for a workflow file. */
const WORKFLOW_EXTENSIONS = ['.yml', '.yaml'] as const;

/**
 * Checkout steps that keep credential persistence, each with the git operation
 * that requires it.
 *
 * Empty today, and that is the finding rather than an oversight: no job in this
 * repository performs a networked git operation. `release.yml` does publish a
 * release, but it takes its token explicitly through `GH_TOKEN` instead — see the
 * comment on its own checkout step.
 */
const CREDENTIALED_STEPS: ReadonlyMap<string, string> = new Map();

/** One `actions/checkout` step, located for reporting. */
export interface CheckoutStep {
  /** Workflow file name, e.g. `ci.yml`. */
  readonly workflow: string;
  /** 1-indexed line of the step's `- ` marker. */
  readonly line: number;
  /** The step's lines, comments stripped. */
  readonly body: readonly string[];
}

/**
 * Removes a YAML comment from one line.
 *
 * YAML requires whitespace before an inline `#`, which is what keeps this off
 * the shell parameter expansions in these workflows' `run:` blocks
 * (`${GITHUB_REF_NAME#v}`, `${source#packages/}`). A `#` inside a quoted string
 * is not handled, and does not need to be: the only consequence would be losing
 * part of a line, and neither `uses: actions/checkout` nor
 * `persist-credentials: false` is ever written inside quotes — so the error can
 * only ever drop a step or a decision, both of which fail closed.
 *
 * @param line - One raw line
 * @returns The line with any comment removed
 */
export function stripComment(line: string): string {
  const match = /(^|\s)#/.exec(line);
  return match === null ? line : line.slice(0, match.index + (match[1] === '' ? 0 : 1));
}

/**
 * Splits a workflow's text into its list items, comments stripped.
 *
 * A step runs from its `- ` marker to the next non-blank line at or left of that
 * marker's indentation, which is what bounds a step to itself rather than
 * letting a later step's settings satisfy the assertion for an earlier one.
 *
 * @param text - The workflow file's contents
 * @param workflow - The file name, for reporting
 * @returns Every `actions/checkout` step in the file
 */
export function workflowCheckoutSteps(
  text: string,
  workflow: string,
): readonly CheckoutStep[] {
  const raw = text.split('\n');
  const steps: CheckoutStep[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    // Anchored on the list marker, NOT on `- uses:`: a step may name itself
    // first (`- name:` then `uses:`), which is the commoner GitHub style and was
    // wholly invisible to this gate's first version.
    const marker = /^(\s*)- /.exec(raw[index] ?? '');
    if (marker === null) continue;
    const indent = (marker[1] ?? '').length;
    let end = index + 1;
    while (end < raw.length) {
      const line = raw[end] ?? '';
      const leading = line.length - line.trimStart().length;
      if (line.trim() !== '' && leading <= indent) break;
      end += 1;
    }
    const body = raw.slice(index, end).map(stripComment);
    if (body.some((line) => /^\s*(- )?uses:\s*actions\/checkout(@|\s*$)/.test(line))) {
      steps.push({ workflow, line: index + 1, body });
    }
    // Continue from inside the step rather than skipping it: a `run: |` block can
    // contain a line starting with `- `, and treating that as a step is harmless
    // because it carries no `uses:`.
  }
  return steps;
}

/**
 * Whether a step explicitly drops the persisted credential.
 *
 * Requires a real mapping line. A commented mention does not count — that is the
 * exact false pass this gate was reviewed for — and neither does any form this
 * does not recognise, which fails closed.
 *
 * @param step - The step to inspect
 * @returns `true` when `persist-credentials: false` is set
 */
export function dropsCredential(step: CheckoutStep): boolean {
  return step.body.some((line) => /^\s*persist-credentials:\s*false\s*$/.test(line));
}

/** Every `actions/checkout` step across every workflow, in a stable order. */
async function checkoutSteps(): Promise<readonly CheckoutStep[]> {
  const steps: CheckoutStep[] = [];
  for await (const entry of Deno.readDir(WORKFLOW_DIR)) {
    if (!entry.isFile) continue;
    if (!WORKFLOW_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    const text = await Deno.readTextFile(`${WORKFLOW_DIR}/${entry.name}`);
    steps.push(...workflowCheckoutSteps(text, entry.name));
  }
  return steps.sort((a, b) =>
    a.workflow === b.workflow ? a.line - b.line : a.workflow.localeCompare(b.workflow)
  );
}

describe('workflow checkout credentials', () => {
  it('finds every checkout step', async () => {
    const steps = await checkoutSteps();
    // A vacuity guard: a scanner that matched nothing would satisfy the decision
    // assertion below. The count is deliberately a floor rather than an equality
    // — adding a job should fail the decision assertion, not this line.
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
        expect(dropsCredential(step)).toBe(false);
        continue;
      }
      if (!dropsCredential(step)) undecided.push(identifier);
    }
    expect(undecided).toEqual([]);
  });

  it('reads each step in isolation', async () => {
    // The step bound is load-bearing: without it, one job's
    // `persist-credentials: false` would satisfy the assertion for every
    // checkout after it in the same file. `ci.yml` has six.
    const steps = (await checkoutSteps()).filter((step) => step.workflow === 'ci.yml');
    expect(steps.length).toBe(6);
    for (const step of steps) {
      const body = step.body.join('\n');
      expect(body.match(/uses:\s*actions\/checkout@/g)?.length).toBe(1);
      expect(body).not.toContain('denoland/setup-deno');
    }
  });

  describe('scanner', () => {
    const stepOf = (yaml: string): CheckoutStep => {
      const [step] = workflowCheckoutSteps(yaml, 'probe.yml');
      if (step === undefined) throw new Error('no checkout step found');
      return step;
    };

    it('sees a step that names itself before its `uses`', () => {
      // Invisible to this gate's first version, and the commoner GitHub style.
      const step = stepOf(`jobs:
  build:
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4
`);
      expect(dropsCredential(step)).toBe(false);
    });

    it('sees a step in a `.yaml` workflow', async () => {
      // The extension list is what this covers; the parser is shared.
      const directory = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(
          `${directory}/probe.yaml`,
          'jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n',
        );
        const names: string[] = [];
        for await (const entry of Deno.readDir(directory)) {
          if (WORKFLOW_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
            names.push(entry.name);
          }
        }
        expect(names).toEqual(['probe.yaml']);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it('does not accept a COMMENT mentioning the setting', () => {
      // The third false pass found in review: the raw-substring check read this
      // as a decision.
      const step = stepOf(`jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          # We deliberately do NOT set persist-credentials: false here.
          fetch-depth: 0
`);
      expect(dropsCredential(step)).toBe(false);
    });

    it('accepts a real setting', () => {
      const step = stepOf(`jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
`);
      expect(dropsCredential(step)).toBe(true);
    });

    it('fails closed on a form it does not recognise', () => {
      // Flow style and a quoted value are both legal YAML and both REFUSED, so
      // an unrecognised spelling is a named failure rather than a silent pass.
      for (
        const yaml of [
          'jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n        with: { persist-credentials: false }\n',
          "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: 'false'\n",
        ]
      ) {
        expect(dropsCredential(stepOf(yaml))).toBe(false);
      }
    });

    it('does not treat a commented-out checkout as a step', () => {
      expect(
        workflowCheckoutSteps(
          'jobs:\n  b:\n    steps:\n      # - uses: actions/checkout@v4\n      - run: echo\n',
          'probe.yml',
        ),
      ).toEqual([]);
    });

    it('leaves a shell parameter expansion alone', () => {
      // YAML needs whitespace before an inline `#`, which is what keeps comment
      // stripping off `${GITHUB_REF_NAME#v}` in these workflows' run blocks.
      expect(stripComment('          version="${GITHUB_REF_NAME#v}"')).toBe(
        '          version="${GITHUB_REF_NAME#v}"',
      );
      // Indentation is preserved and only the comment text goes, so these assert
      // the intent rather than the exact trailing whitespace.
      expect(stripComment('  fetch-depth: 0 # full history').trimEnd()).toBe('  fetch-depth: 0');
      expect(stripComment('  # whole-line comment').trim()).toBe('');
    });
  });
});
