/**
 * Exercises the executable prose-assertion gate's grammar, sandbox, and CI
 * wiring. The gate is useful only when a false claim demonstrably fails.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  buildProgram,
  checkDocument,
  collectMarkdown,
  compareClaim,
  evaluateClaims,
  findClaimBlocks,
  MARKER,
  parseClaimTable,
  parseResults,
  run,
  SCAN_ROOTS,
} from '../scripts/check-prose-assertions.ts';
import { SCRIPT_TARGETS } from '../scripts/script-coverage.ts';

const TABLE = [
  `<!-- ${MARKER} -->`,
  '',
  '| Expression | Value |',
  '| ---------- | ----- |',
  '| `Infinity > 0` | `true` |',
  '| `NaN > 1` | `false` |',
].join('\n');

describe('prose assertion gate — marker and grammar', () => {
  it('finds a marker written in Markdown, YAML, or TypeScript comment syntax', () => {
    for (const marker of [`<!-- ${MARKER} -->`, `# ${MARKER}`, `// ${MARKER.toUpperCase()}`]) {
      expect(
        findClaimBlocks(
          `${marker}\n\n| Expression | Value |\n| - | - |\n| \`1 === 1\` | \`true\` |`,
        ).length,
      )
        .toBe(1);
    }
  });

  it('does not treat an unmarked table as a claim block', () => {
    expect(findClaimBlocks(TABLE.slice(TABLE.indexOf('|'))).length).toBe(0);
  });

  it('does not mistake prose mentioning the marker for an assertion', () => {
    const source =
      `${MARKER} is a marker.\n\n| Expression | Value |\n| - | - |\n| \`1 === 1\` | \`true\` |`;

    expect(findClaimBlocks(source)).toEqual([]);
  });

  it('parses table cells, unescapes pipes, and retains source lines', () => {
    const source = [
      `<!-- ${MARKER} -->`,
      '',
      '| Expression | Value |',
      '| ---------- | ----- |',
      '| `"a" + "\\|b"` | `"a\\|b"` |',
    ].join('\n');
    const block = findClaimBlocks(source)[0];
    if (block === undefined) throw new Error('Expected a marked block');
    const claims = parseClaimTable(block);

    expect(claims).toEqual([{ expression: '"a" + "|b"', expected: 'a|b', line: 5 }]);
  });

  it('does not alter backslashes that are not Markdown pipe escapes', () => {
    const source = [
      `<!-- ${MARKER} -->`,
      '',
      '| Expression | Value |',
      '| ---------- | ----- |',
      '| `"\\\\d"` | `"\\\\d"` |',
    ].join('\n');
    const block = findClaimBlocks(source)[0];
    if (block === undefined) throw new Error('Expected a marked block');

    expect(parseClaimTable(block)[0]?.expression).toBe('"\\\\d"');
  });

  it('rejects malformed rows and values that are not JSON literals', () => {
    const malformed = findClaimBlocks(
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |\n| value | \`true\` |`,
    )[0];
    const invalidValue = findClaimBlocks(
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |\n| \`1\` | \`yes\` |`,
    )[0];
    if (malformed === undefined || invalidValue === undefined) {
      throw new Error('Expected marked blocks');
    }

    expect(() => parseClaimTable(malformed)).toThrow('inline-code');
    expect(() => parseClaimTable(invalidValue)).toThrow('JSON literal');
  });

  it('rejects incomplete tables, bad headers, separators, and cell counts', () => {
    const cases = [
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |`,
      `<!-- ${MARKER} -->\n\n| Actual | Value |\n| - | - |\n| \`1\` | \`1\` |`,
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| x | x |\n| \`1\` | \`1\` |`,
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |\n| \`1\` | \`1\` | \`2\` |`,
    ];

    for (const source of cases) {
      const block = findClaimBlocks(source)[0];
      if (block === undefined) throw new Error('Expected a marked block');
      expect(() => parseClaimTable(block)).toThrow();
    }
  });

  it('reports a malformed marked table as a document finding', async () => {
    const source = `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |\n| value | \`true\` |`;

    expect((await checkDocument('malformed.md', source))[0]?.message).toContain('Malformed');
  });
});

describe('prose assertion gate — evaluator', () => {
  it('wraps every expression in its own catch block', () => {
    const block = findClaimBlocks(TABLE)[0];
    if (block === undefined) throw new Error('Expected a marked block');
    const program = buildProgram(parseClaimTable(block));

    expect(program.match(/try \{/g)?.length).toBe(2);
    expect(program).toContain('catch (error)');
  });

  it('evaluates false and true numeric claims separately', async () => {
    const block = findClaimBlocks(TABLE)[0];
    if (block === undefined) throw new Error('Expected a marked block');
    const results = await evaluateClaims(parseClaimTable(block));

    expect(results).toEqual([{ ok: true, value: true }, { ok: true, value: false }]);
  });

  it('denies filesystem access to an expression from the document', async () => {
    const source =
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |\n| \`Deno.readTextFileSync('/etc/hostname')\` | \`"unreachable"\` |`;
    const findings = await checkDocument('sandbox.md', source);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('NotCapable');
  });

  it('fails closed when a claim exits before every result is emitted', async () => {
    const source =
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |\n| \`Deno.exit(0)\` | \`null\` |\n| \`1 === 1\` | \`true\` |`;
    const findings = await checkDocument('exit.md', source);

    expect(findings.length).toBe(2);
    expect(findings.every((finding) => finding.message.includes('Unverified'))).toBe(true);
  });

  it('uses one batch for every valid table in a document', async () => {
    const source = [
      `<!-- ${MARKER} -->`,
      '',
      '| Expression | Value |',
      '| - | - |',
      '| `Deno.exit(0)` | `null` |',
      '',
      `<!-- ${MARKER} -->`,
      '',
      '| Expression | Value |',
      '| - | - |',
      '| `1 === 1` | `true` |',
    ].join('\n');
    const findings = await checkDocument('two-tables.md', source);

    expect(findings.length).toBe(2);
    expect(findings.every((finding) => finding.message.includes('Unverified'))).toBe(true);
  });

  it('fails closed when a document batch exceeds its timeout', async () => {
    const source =
      `<!-- ${MARKER} -->\n\n| Expression | Value |\n| - | - |\n| \`(() => { while (true) {} })()\` | \`null\` |`;
    const findings = await checkDocument('timeout.md', source, 20);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('Unverified');
  });

  it('rejects short and malformed sandbox output', () => {
    expect(parseResults('{"ok":true,"value":true}', 2)).toBeNull();
    expect(parseResults('not json', 1)).toBeNull();
    expect(parseResults('{"ok":true}', 1)).toBeNull();
    expect(parseResults('[]', 1)).toBeNull();
  });

  it('reports a false expected value with the claim source line', () => {
    const finding = compareClaim(
      { expression: 'Infinity > 0', expected: false, line: 12 },
      { ok: true, value: true },
    );

    expect(finding).toEqual({
      file: '',
      line: 12,
      message: 'Expected false, received true.',
    });
  });

  it('reports an absent result as unverified and accepts a matching result', () => {
    const claim = { expression: '1', expected: 1, line: 5 };

    expect(compareClaim(claim, undefined)?.message).toContain('Unverified');
    expect(compareClaim(claim, { ok: true, value: 1 })).toBeNull();
  });

  it('treats JSON objects with a different property order as equal', () => {
    const claim = { expression: '({ a: 1, b: 2 })', expected: { b: 2, a: 1 }, line: 5 };

    expect(compareClaim(claim, { ok: true, value: { a: 1, b: 2 } })).toBeNull();
  });
});

describe('prose assertion gate — inventory and wiring', () => {
  it('pins the seeded numeric-claim inventory', async () => {
    const source = await Deno.readTextFile('.roo/rules-code-review/01-review-only.md');
    const claims = findClaimBlocks(source).flatMap((block) => parseClaimTable(block));

    expect(claims.length).toBe(12);
  });

  it('scans .roo and is wired into both documentation gates', async () => {
    const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as {
      tasks: Record<string, string>;
    };

    expect(SCAN_ROOTS).toContain('.roo');
    expect(manifest.tasks['check:docs']).toContain('scripts/check-prose-assertions.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/check-prose-assertions.ts');
  });

  it('walks a scan root and runs an explicit document path', async () => {
    const files = await collectMarkdown('.roo');
    const findings = await run(['.roo/rules-code-review/01-review-only.md']);

    expect(files).toContain('.roo/rules-code-review/01-review-only.md');
    expect(findings).toEqual([]);
  });

  it('reports an invalid timeout without exiting the test process', async () => {
    const findings = await run(['--timeout=0']);

    expect(findings[0]?.file).toBe('arguments');
  });

  it('ignores hidden directories and reports an unreadable explicit file', async () => {
    const files = await collectMarkdown('.');
    const findings = await run(['does-not-exist.md']);

    expect(files.some((file) => file.startsWith('.git/'))).toBe(false);
    expect(findings[0]?.message).toContain('Cannot read document');
  });
});
