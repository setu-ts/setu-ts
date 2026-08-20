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
import { auditPackageSources, findComputedImports } from '../../scripts/npm-specifier-audit.ts';

describe('findComputedImports — literal arguments are accepted', () => {
  it('accepts a single-quoted literal', () => {
    expect(findComputedImports("const m = await import('npm:pino@10.x');")).toHaveLength(0);
  });

  it('accepts a bare npm: literal (the @connectrpc/connect shape)', () => {
    expect(
      findComputedImports("const m = await import('npm:@connectrpc/connect');"),
    ).toHaveLength(0);
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
  it('rejects a concatenated string argument (X7-3 bypass)', () => {
    const findings = findComputedImports("const m = await import('npm:' + name);");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.snippet).toContain("'npm:' + name");
  });

  it('rejects a string argument composed with a template literal', () => {
    const findings = findComputedImports('const m = await import(`npm:` + name);');
    expect(findings).toHaveLength(1);
  });

  it('rejects a string argument cast with `as`', () => {
    const findings = findComputedImports("const m = await import('npm:foo' as string);");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.snippet).toContain("'npm:foo' as string");
  });

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

describe('auditPackageSources — which src trees the walker reaches', () => {
  /**
   * Builds a throwaway package tree and returns its root. The nesting is the
   * point: `flat/src` sits one level down, `group/nested/src` two — the shape
   * `packages/starters/<name>/src` has, and the shape the first version of this
   * walker silently skipped while still reporting a healthy file count.
   */
  async function createTree(): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: 'setu-audit-' });
    await Deno.mkdir(`${root}/flat/src`, { recursive: true });
    await Deno.writeTextFile(`${root}/flat/src/a.ts`, "await import('npm:ok@1');\n");
    await Deno.mkdir(`${root}/group/nested/src/deep`, { recursive: true });
    await Deno.writeTextFile(`${root}/group/nested/src/deep/b.ts`, 'export const b = 1;\n');
    return root;
  }

  it('reaches a src tree nested more than one level below the root', async () => {
    const root = await createTree();
    try {
      const result = await auditPackageSources(root);
      expect(result.srcRootsVisited).toContain(`${root}/flat/src`);
      expect(result.srcRootsVisited).toContain(`${root}/group/nested/src`);
      expect(result.filesVisited).toBe(2);
      expect(result.findings).toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it('refuses a computed import in a deeply nested src tree', async () => {
    const root = await createTree();
    try {
      await Deno.writeTextFile(
        `${root}/group/nested/src/deep/b.ts`,
        'const load = (spec: string) => import(spec);\nexport const l = load;\n',
      );
      const result = await auditPackageSources(root);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].file).toBe(`${root}/group/nested/src/deep/b.ts`);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it('never audits a vendored node_modules tree', async () => {
    const root = await createTree();
    try {
      await Deno.mkdir(`${root}/flat/node_modules/dep/src`, { recursive: true });
      await Deno.writeTextFile(
        `${root}/flat/node_modules/dep/src/vendor.ts`,
        'const load = (spec: string) => import(spec);\nexport const l = load;\n',
      );
      const result = await auditPackageSources(root);
      // A dependency's own source is not ours to gate; it must not appear as a
      // root, be counted, or be reported.
      expect(result.srcRootsVisited.some((r) => r.includes('node_modules'))).toBe(false);
      expect(result.filesVisited).toBe(2);
      expect(result.findings).toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it('returns an empty result for a root that does not exist', async () => {
    const result = await auditPackageSources('/nonexistent-setu-audit-root');
    expect(result.srcRootsVisited).toEqual([]);
    expect(result.filesVisited).toBe(0);
    expect(result.findings).toEqual([]);
  });
});
