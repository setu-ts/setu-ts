/**
 * Unit tests for the computed-`import()` recurrence gate (M70e §3.7/§3.8).
 *
 * Exercises the pure `findComputedImports` core against deterministic source
 * snippets so the scanner's discrimination is proven without a live tree. The
 * whole-tree check lives in `test/npm-specifier-gate.test.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { findComputedImports } from '../../scripts/npm-specifier-audit.ts';

describe('findComputedImports — literal arguments are accepted', () => {
  it('accepts a single-quoted literal', () => {
    expect(findComputedImports("const m = await import('npm:pino@10.x');")).toHaveLength(0);
  });

  it('accepts a double-quoted literal', () => {
    expect(findComputedImports('const m = await import("npm:pino@10.x");')).toHaveLength(0);
  });

  it('accepts a clean template-literal argument', () => {
    expect(findComputedImports('const m = await import(`npm:pino@10.x`);')).toHaveLength(0);
  });

  it('accepts a multi-line literal (the otlp-exporter shape)', () => {
    const source = [
      'const mod = await import(',
      '  "npm:@opentelemetry/otlp-exporter-base@^0.220.0",',
      ');',
    ].join('\n');
    expect(findComputedImports(source)).toHaveLength(0);
  });
});

describe('findComputedImports — computed arguments are rejected', () => {
  it('rejects an identifier argument', () => {
    const findings = findComputedImports('const m = await import(spec);');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.file).toBe('');
    expect(findings[0]?.snippet).toContain('import(');
  });

  it('rejects a member-expression argument', () => {
    const findings = findComputedImports('const m = await import(mod.spec);');
    expect(findings).toHaveLength(1);
  });

  it('rejects an interpolated template argument', () => {
    const findings = findComputedImports('const m = await import(`npm:${name}`);');
    expect(findings).toHaveLength(1);
  });

  it('rejects a nested-interpolation template argument', () => {
    const findings = findComputedImports('const m = await import(`a${`b`}c`);');
    expect(findings).toHaveLength(1);
  });

  it('finds every computed import in a multi-import source', () => {
    const source = [
      "const a = import('npm:ok');",
      'const b = import(x);',
      'const c = import(y.z);',
    ].join('\n');
    const findings = findComputedImports(source);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line).sort()).toEqual([2, 3]);
  });
});

describe('findComputedImports — comments and strings are ignored', () => {
  it('ignores an import() inside a line comment', () => {
    expect(findComputedImports('// import(x)\nconst a = 1;')).toHaveLength(0);
  });

  it('ignores an import() inside a block comment', () => {
    expect(findComputedImports('/* import(x) */\nconst a = 1;')).toHaveLength(0);
  });

  it('ignores an import() inside a string literal', () => {
    expect(findComputedImports("const s = 'import(x)';")).toHaveLength(0);
  });

  it('ignores import.meta', () => {
    expect(findComputedImports('const x = import.meta.url;')).toHaveLength(0);
  });

  it('still finds a real computed import that follows a comment', () => {
    const source = '/* import(x) */\nconst m = await import(spec);';
    const findings = findComputedImports(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });
});

describe('findComputedImports — the computed-specifier marker', () => {
  it('accepts a marker on the preceding line', () => {
    const source = '/* computed-specifier: app-supplied path */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(0);
  });

  it('accepts a marker inline', () => {
    const source = 'const m = import(/* computed-specifier: app-supplied path */ url);';
    expect(findComputedImports(source)).toHaveLength(0);
  });

  it('rejects a marker with an empty reason', () => {
    const source = '/* computed-specifier: */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });

  it('rejects a marker that only has whitespace as its reason', () => {
    const source = '/* computed-specifier:    */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });

  it('does not treat an unrelated comment as a marker', () => {
    const source = '/* some other note */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });

  it('requires the marker to be adjacent (not two lines above)', () => {
    const source = '/* computed-specifier: reason */\n\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });
});
