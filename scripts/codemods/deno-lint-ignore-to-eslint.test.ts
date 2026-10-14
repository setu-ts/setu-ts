import { describe, it, expect } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { convertSource, main, RULE_MAP, trackedSources } from './deno-lint-ignore-to-eslint.ts';
import { tempDir } from '../../test/node-helpers.ts';

const convert = (source: string) => convertSource('sample.ts', source);

describe('deno-lint-ignore-to-eslint codemod', () => {
  it('converts a next-line directive and keeps its reason', () => {
    const result = convert(
      '// deno-lint-ignore require-await -- must reject, not throw\nasync function f() {}\n',
    );
    expect(result.text).toBe(
      '// eslint-disable-next-line require-await -- must reject, not throw\nasync function f() {}\n',
    );
    expect(result.converted).toBe(1);
  });

  it('converts a file-level directive to a block disable', () => {
    const result = convert('// deno-lint-ignore-file no-console -- tooling\nconsole.log(1);\n');
    expect(result.text).toBe('/* eslint-disable no-console -- tooling */\nconsole.log(1);\n');
  });

  it('maps each rule of a list, by comma or by space, and drops ban-unused-ignore', () => {
    expect(convert('// deno-lint-ignore-file no-explicit-any, require-await\n').text).toBe(
      '/* eslint-disable @typescript-eslint/no-explicit-any, require-await */\n',
    );
    expect(
      convert('// deno-lint-ignore-file no-explicit-any ban-unused-ignore require-await\n').text,
    ).toBe('/* eslint-disable @typescript-eslint/no-explicit-any, require-await */\n');
  });

  it('maps ban-types to the rule for a bare Function type', () => {
    expect(convert('// deno-lint-ignore ban-types\n').text).toBe(
      '// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type\n',
    );
  });

  it('converts an indented directive in place', () => {
    expect(convert('  // deno-lint-ignore no-this-alias\n').text).toBe(
      '  // eslint-disable-next-line @typescript-eslint/no-this-alias\n',
    );
  });

  it('leaves the words alone in a string, a template and prose', () => {
    const source = [
      "const a = '// deno-lint-ignore require-await';",
      'const b = `// deno-lint-ignore require-await`;',
      '/** a `deno-lint-ignore-file` mention */',
      '// see deno-lint-ignore require-await',
      '',
    ].join('\n');
    expect(convert(source)).toEqual({ text: source, converted: 0, refusals: [] });
  });

  it('finds directives after a regex and a template literal, and none inside them', () => {
    const source = [
      'const r = /a\\/b/g;',
      'const t = `x ${r} // deno-lint-ignore require-await ${r} y`;',
      '// deno-lint-ignore require-await',
      'async function f() {}',
      'const u = `${t}`;',
      '// deno-lint-ignore no-console',
      'console.log(u);',
      '',
    ].join('\n');
    const result = convert(source);
    expect(result.converted).toBe(2);
    expect(result.text).toContain('// deno-lint-ignore require-await ${r} y`');
    expect(result.text).toContain('// eslint-disable-next-line require-await\nasync');
    expect(result.text).toContain('// eslint-disable-next-line no-console\nconsole');
  });

  it('parses a .tsx file as JSX', () => {
    const source =
      'const a = <div>{1 / 2}</div>;\n// deno-lint-ignore no-console\nconsole.log(a);\n';
    expect(convertSource('view.tsx', source).converted).toBe(1);
  });

  it('leaves directive-shaped JSX text alone, and converts a comment in a JSX expression', () => {
    const text = [
      'export const a = (',
      '  <div>',
      '    // deno-lint-ignore no-console',
      '    // deno-lint-ignore-file require-await',
      '  </div>',
      ');',
      '',
    ].join('\n');
    expect(convertSource('view.tsx', text)).toEqual({ text, converted: 0, refusals: [] });
    const expression =
      'export const b = (\n  <div>\n    {\n      // deno-lint-ignore no-console\n      console.log(1)\n    }\n  </div>\n);\n';
    expect(convertSource('view.tsx', expression).text).toContain(
      '// eslint-disable-next-line no-console\n      console.log(1)',
    );
  });

  it('refuses an unmapped rule by line and leaves the file unchanged', () => {
    const source = '// deno-lint-ignore require-await\nx;\n// deno-lint-ignore no-window\n';
    const result = convert(source);
    expect(result.text).toBe(source);
    expect(result.converted).toBe(0);
    expect(result.refusals).toEqual([
      { file: 'sample.ts', line: 3, detail: "no ESLint mapping for 'no-window'" },
    ]);
  });

  it('refuses a rule-less directive and one naming only dropped rules', () => {
    expect(convert('// deno-lint-ignore-file\n').refusals[0]?.detail).toContain('blanket');
    expect(convert('// deno-lint-ignore ban-unused-ignore\n').refusals[0]?.detail).toContain(
      'delete the directive',
    );
  });

  it('refuses a file-level reason that would close the block early', () => {
    expect(
      convert('// deno-lint-ignore-file no-console -- a */ b\n').refusals[0]?.detail,
    ).toContain("'*/'");
  });

  it('does not treat inherited names as rules', () => {
    expect(convert('// deno-lint-ignore toString\n').refusals[0]?.detail).toBe(
      "no ESLint mapping for 'toString'",
    );
  });

  it('is idempotent', () => {
    const once = convert('// deno-lint-ignore no-control-regex\n/\\x00/;\n').text;
    expect(convert(once)).toEqual({ text: once, converted: 0, refusals: [] });
  });

  it('maps every rule present in the tree', () => {
    expect(Object.keys(RULE_MAP).sort()).toEqual([
      'ban-types',
      'ban-unused-ignore',
      'no-console',
      'no-control-regex',
      'no-explicit-any',
      'no-this-alias',
      'no-unused-vars',
      'require-await',
    ]);
  });

  it('reports without writing, then writes, then finds nothing left', async () => {
    const directory = await tempDir();
    const file = `${directory}/sample.ts`;
    const source = '// deno-lint-ignore no-console\nconsole.log(1);\n';
    try {
      await writeFile(file, source);
      const lines: string[] = [];
      expect(main([file], (line) => lines.push(line))).toBe(0);
      expect(lines).toEqual([`would convert 1 in ${file}`]);
      expect(await readFile(file, 'utf8')).toBe(source);
      expect(main(['--write', file], (line) => lines.push(line))).toBe(0);
      expect(await readFile(file, 'utf8')).toContain('eslint-disable-next-line no-console');
      lines.length = 0;
      expect(main(['--write', file], (line) => lines.push(line))).toBe(0);
      expect(lines).toEqual([]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('exits 1 and names the location when a rule cannot be mapped', async () => {
    const directory = await tempDir();
    const file = `${directory}/sample.ts`;
    try {
      await writeFile(file, '\n// deno-lint-ignore no-window\n');
      const lines: string[] = [];
      expect(main(['--write', file], (line) => lines.push(line))).toBe(1);
      expect(lines).toEqual([`${file}:2: no ESLint mapping for 'no-window'`]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('lists tracked sources when no file is named', () => {
    const files = trackedSources();
    expect(files).toContain('scripts/codemods/std-to-vitest.ts');
    expect(files.every((file) => /\.(ts|tsx|js|mjs)$/.test(file))).toBe(true);
  });

  it('refuses nothing across the tracked tree', () => {
    const lines: string[] = [];
    expect(main([], (line) => lines.push(line))).toBe(0);
    expect(lines.filter((line) => !line.startsWith('would convert '))).toEqual([]);
  });
});
