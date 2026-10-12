/**
 * The plan linter's compatibility-statement rule.
 *
 * The rule exists so the release that carries a breaking change is chosen when
 * the break is designed (plan time) rather than discovered when a version is
 * cut; each case here shows the refusal firing and its corrected plan passing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { lintText } from '../../scripts/plan-lint.ts';

const SECTIONS = [
  '## 0. Objective & scope',
  '## 1. Contracts verified from SOURCE',
  '## 2. Committed-doc conflicts',
  '## 3. Design decisions',
  '## 4. Exported surface — every symbol names its consumer',
  '## 5. Implementation files',
  '## 6. Test plan',
  '## 7. Verification gates',
  '## 9. Out of scope',
];

/** A plan with every required section, and the given text under §4. */
function plan(surface: string): string {
  return SECTIONS.map((heading) =>
    heading.startsWith('## 4.') ? `${heading}\n\n${surface}\n` : `${heading}\n\nText.\n`
  ).join('\n');
}

const messages = (text: string) =>
  lintText('plans/milestone-999-x.md', text).errors.map((e) => e.message);

describe('plan-lint compatibility statement', () => {
  it('requires the statement, naming the two accepted forms', () => {
    const [message] = messages(plan('| Exported symbol | Kind | Consumer |\n| - | - | - |'));
    expect(message).toContain('missing compatibility statement');
    expect(message).toContain('**Breaking for implementors:** none');
    expect(message).toContain('ships in minor <X.Y.0>');
  });

  it('accepts `none` with a reason', () => {
    expect(messages(plan('**Breaking for implementors:** none — every addition is optional.')))
      .toEqual([]);
  });

  it('accepts a break that names the minor carrying it, including across a reflowed line', () => {
    const inline =
      '**Breaking for implementors:** `Prompter.select` changes type — ships in minor `0.9.0`.';
    expect(messages(plan(inline))).toEqual([]);
    const reflowed =
      '**Breaking for implementors:** `IFoo` gains a required member, which breaks a\n' +
      'hand-written implementor — ships in minor 0.10.0.';
    expect(messages(plan(reflowed))).toEqual([]);
    expect(
      messages(
        plan('**Breaking for implementors:** a required member; carried by the next minor.'),
      ),
    )
      .toEqual([]);
  });

  it('refuses a break that names no minor, at the statement line', () => {
    const text = plan('**Breaking for implementors:** `IFoo.bar` becomes required.');
    const errors = lintText('plans/milestone-999-x.md', text).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('names a break but no minor release to carry it');
    expect(errors[0].line).toBe(text.split('\n').findIndex((l) => l.startsWith('**Breaking')) + 1);
  });

  it("does not read a mention two paragraphs later as the statement's minor", () => {
    const text = plan(
      '**Breaking for implementors:** `IFoo.bar` becomes required.\n\nUnrelated: 0.9.0.',
    );
    expect(messages(text)).toHaveLength(1);
  });

  it('still reports the pre-existing rules beside it', () => {
    const text = plan('**Breaking for implementors:** none') + '\n<FILL: left>\n';
    const found = messages(text);
    expect(found.some((m) => m.includes('unfilled template placeholder'))).toBe(true);
    expect(found.some((m) => m.includes('compatibility statement'))).toBe(false);
  });
});
