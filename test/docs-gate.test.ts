/**
 * Pins the documentation gate: that its checks actually discriminate, and that
 * CI runs it.
 *
 * The defect that motivated the gate — a runaway code fence in `PUBLIC_API.md`
 * that rendered two-thirds of the file as source — passed `deno fmt`, `lint`,
 * `check`, `test`, and both publish gates. A checker nothing runs would be the
 * same failure one level up, so the wiring is asserted here rather than
 * assumed (the `apps-gate.test.ts` precedent, where three deepened Redis tests
 * guarded on an environment variable no workflow set).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  anchorFor,
  checkDocument,
  findSwallowedHeadings,
  scanFences,
} from '../scripts/check-docs.ts';

describe('documentation gate — fence scanning', () => {
  it('does not treat a longer fence as closed by a shorter one', () => {
    // The exact shape of the real defect: ```` opened, ``` cannot close it.
    const lines = ['````typescript', 'code', '```', '', '## Swallowed', 'text'];
    const { unclosedAt, fenced } = scanFences(lines);

    expect(unclosedAt).toBe(1);
    // The heading is inside the runaway block, so it is not a heading.
    expect(fenced[4]).toBe(true);
  });

  it('closes a fence with an equal or longer delimiter of the same character', () => {
    expect(scanFences(['```ts', 'code', '```']).unclosedAt).toBeNull();
    expect(scanFences(['```ts', 'code', '````']).unclosedAt).toBeNull();
    // A tilde fence is not closed by backticks.
    expect(scanFences(['~~~ts', 'code', '```']).unclosedAt).toBe(1);
  });

  it('ignores a delimiter that carries an info string when closing', () => {
    // Line 3 opens a nested-looking fence rather than closing; the block runs on.
    expect(scanFences(['```ts', 'code', '```ts', 'more']).unclosedAt).toBe(1);
  });
});

describe('documentation gate — swallowed headings', () => {
  it('flags a code block whose language cannot have # comments', () => {
    const lines = ['```typescript', 'const a = 1;', '## One', '## Two', '```'];
    const { blocks } = scanFences(lines);
    const suspects = findSwallowedHeadings(lines, blocks);

    expect(suspects.length).toBe(1);
    expect(suspects[0]?.headings).toEqual(['One', 'Two']);
  });

  it('does not flag languages where # is an ordinary comment', () => {
    for (const lang of ['bash', 'sh', 'yaml', 'toml', 'python', 'markdown']) {
      const lines = [`\`\`\`${lang}`, '## One', '## Two', '```'];
      const { blocks } = scanFences(lines);
      expect(findSwallowedHeadings(lines, blocks).length).toBe(0);
    }
  });

  it('tolerates a single stray heading-like line', () => {
    const lines = ['```json', '{ "a": 1 }', '## Only one', '```'];
    const { blocks } = scanFences(lines);
    expect(findSwallowedHeadings(lines, blocks).length).toBe(0);
  });
});

describe('documentation gate — anchors', () => {
  it('derives a renderer anchor from heading text', () => {
    expect(anchorFor('API Reference: @hono-enterprise/common')).toBe(
      'api-reference-hono-enterprisecommon',
    );
    expect(anchorFor('createApplication()')).toBe('createapplication');
    expect(anchorFor('Feature Flags')).toBe('feature-flags');
  });

  it('reports a link that matches no heading', () => {
    const findings = checkDocument('t.md', '# T\n\n## A\n\nSee [B](#nope).\n');
    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('matches no heading');
  });

  it('accepts a link to a heading that exists', () => {
    expect(checkDocument('t.md', '# T\n\n## A\n\nSee [A](#a).\n').length).toBe(0);
  });

  it('ignores headings and links inside code fences', () => {
    const source = '# T\n\n```typescript\n// [X](#nowhere)\n```\n';
    expect(checkDocument('t.md', source).length).toBe(0);
  });

  it('disambiguates repeated headings the way a renderer does', () => {
    const source = '# T\n\n## Dup\n\n## Dup\n\n[first](#dup) [second](#dup-1)\n';
    expect(checkDocument('t.md', source).length).toBe(0);
  });
});

describe('documentation gate — table of contents', () => {
  it('reports a section with no contents entry', () => {
    const source = '# T\n\n## Table of Contents\n\n1. [A](#a)\n\n## A\n\n## B\n';
    const findings = checkDocument('t.md', source);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('"B" has no Table of Contents entry');
  });

  it('does not require a contents entry in a file with no contents section', () => {
    expect(checkDocument('t.md', '# T\n\n## A\n\n## B\n').length).toBe(0);
  });
});

describe('documentation gate — CI wiring', () => {
  it('is registered as a task', async () => {
    const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as {
      tasks: Record<string, string>;
    };
    expect(manifest.tasks['check:docs']).toContain('scripts/check-docs.ts');
  });

  it('runs on every pull request', async () => {
    // Without this the gate is a script nobody executes, and the class of
    // defect it exists for reaches main exactly as it did before.
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    expect(workflow).toContain('deno task check:docs');
  });
});
