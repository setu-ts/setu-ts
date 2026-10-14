import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { auditSideEffects, SIDE_EFFECT_MODULES } from '../../scripts/side-effects.ts';

describe('sideEffects audit', () => {
  const approved = Object.keys(SIDE_EFFECT_MODULES)[0];
  it('finds expressions and import targets and refuses unknown effects', () => {
    const result = auditSideEffects(
      new Map([
        [approved, 'install();'],
        [
          'packages/decorator-plugin/src/decorators/a.ts',
          "import '../metadata/symbol-metadata.ts';",
        ],
        ['x.ts', "import 'external'; mutate();"],
      ]),
    );
    expect(result.findings.map((f) => f.kind)).toEqual([
      'expression',
      'import',
      'import',
      'expression',
    ]);
    expect(result.refusals).toHaveLength(2);
    expect(result.findings[1].module).toBe(approved);
  });
  it('refuses a stale approval and ignores comments, strings and templates', () => {
    expect(auditSideEffects(new Map([[approved, '// install();']])).refusals[0]).toContain('stale');
    const source =
      "const text = `import './effect.ts'; mutate();`; // mutate();\nconst literal = 'mutate()';";
    expect(auditSideEffects(new Map([['x.ts', source]])).findings).toEqual([]);
    expect(auditSideEffects(new Map()).refusals).toEqual([]);
  });
  it('permits only function assignments to a module-top-level let', () => {
    expect(
      auditSideEffects(
        new Map([
          ['x.ts', 'let seam; class C { static { seam = () => 1; seam = function () {}; } }'],
        ]),
      ).refusals,
    ).toEqual([]);
    for (const source of [
      'class C { static { call(); } }',
      'class C { static { globalThis.x = () => 1; } }',
      "import { seam } from './other.ts'; class C { static { seam = () => 1; } }",
      'let seam; class C { static { seam = 1; } }',
      'function f() { let seam; } class C { static { seam = () => 1; } }',
      'const seam = 1; class C { static { seam = () => 1; } }',
      'let seam; class C { static { seam += () => 1; } }',
      'let { seam } = value; class C { static { seam = () => 1; } }',
    ]) {
      expect(auditSideEffects(new Map([['x.ts', source]])).findings.map((f) => f.kind)).toContain(
        'static-block',
      );
    }
  });
  it('classifies all three real M98 seams as local', async () => {
    const files = new Map<string, string>();
    for (const path of [
      'packages/cache-plugin/src/services/cache-service.ts',
      'packages/health-plugin/src/services/health-service.ts',
      'packages/scheduler-plugin/src/services/scheduler-service.ts',
    ])
      files.set(path, await Deno.readTextFile(path));
    expect(auditSideEffects(files)).toEqual({ findings: [], refusals: [] });
  });
});
