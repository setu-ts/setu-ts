import { describe, expect, it } from 'vitest';
import { planNodeDevtool, NODE_DEVTOOL_DEV_SCRIPT } from '../../src/devtool/npm-manifest.ts';
import { FRAMEWORK_RANGE } from '../../src/templates/framework-specifier.ts';

const plugin = '@setu-ts/diagnostics-plugin';
const base = { devDependencies: { tsx: '^4.20.0' } };
const complete = {
  scripts: { dev: NODE_DEVTOOL_DEV_SCRIPT },
  devDependencies: { ...base.devDependencies, [plugin]: FRAMEWORK_RANGE },
};

describe('planNodeDevtool manifest shapes', () => {
  const rows: readonly {
    name: string;
    source: string;
    outcome: 'write' | 'noop' | 'refuse';
    message?: string;
  }[] = [
    {
      name: 'adds both entries without a scripts or dependencies map',
      source: JSON.stringify(base),
      outcome: 'write',
    },
    {
      name: 'strips a UTF-8 BOM before parsing',
      source: '\uFEFF' + JSON.stringify(base),
      outcome: 'write',
    },
    {
      name: 'refuses invalid JSON',
      source: '{',
      outcome: 'refuse',
      message: 'Invalid JSON in package.json',
    },
    {
      name: 'refuses a non-object root',
      source: 'null',
      outcome: 'refuse',
      message: 'JSON object',
    },
    { name: 'refuses an array root', source: '[]', outcome: 'refuse', message: 'JSON object' },
    {
      name: 'refuses a malformed dependency map',
      source: JSON.stringify({ ...base, dependencies: [] }),
      outcome: 'refuse',
      message: 'dependencies must be an object of strings',
    },
    {
      name: 'refuses a non-string devDependency',
      source: JSON.stringify({ devDependencies: { tsx: false } }),
      outcome: 'refuse',
      message: 'devDependencies must be an object of strings',
    },
    {
      name: 'refuses a malformed scripts map',
      source: JSON.stringify({ ...base, scripts: { dev: null } }),
      outcome: 'refuse',
      message: 'scripts must be an object of strings',
    },
    {
      name: 'refuses a framework pin in dependencies',
      source: JSON.stringify({ ...base, dependencies: { '@setu-ts/common': '^0.1.0' } }),
      outcome: 'refuse',
      message: '@setu-ts/common: ^0.1.0',
    },
    {
      name: 'refuses a framework pin in devDependencies',
      source: JSON.stringify({
        devDependencies: { ...base.devDependencies, '@setu-ts/cli': '^0.1.0' },
      }),
      outcome: 'refuse',
      message: '@setu-ts/cli: ^0.1.0',
    },
    {
      name: 'refuses a different diagnostics pin',
      source: JSON.stringify({ devDependencies: { ...base.devDependencies, [plugin]: '^0.1.0' } }),
      outcome: 'refuse',
      message: '@setu-ts/diagnostics-plugin: ^0.1.0',
    },
    {
      name: 'refuses diagnostics in production dependencies',
      source: JSON.stringify({ ...base, dependencies: { [plugin]: FRAMEWORK_RANGE } }),
      outcome: 'refuse',
      message: 'Move it to devDependencies',
    },
    {
      name: 'refuses diagnostics in both sections',
      source: JSON.stringify({ ...complete, dependencies: { [plugin]: FRAMEWORK_RANGE } }),
      outcome: 'refuse',
      message: 'Move it to devDependencies',
    },
    {
      name: 'requires tsx as a devDependency',
      source: '{}',
      outcome: 'refuse',
      message: 'requires tsx in devDependencies',
    },
    {
      name: 'refuses tsx present only in dependencies',
      source: JSON.stringify({ dependencies: { tsx: '^4.20.0' } }),
      outcome: 'refuse',
      message: 'requires tsx in devDependencies',
    },
    {
      name: 'refuses a developer-owned dev script',
      source: JSON.stringify({ ...base, scripts: { dev: 'my-server' } }),
      outcome: 'refuse',
      message: 'A script you wrote is yours',
    },
    {
      name: 'adds only the dependency to a matching dev script',
      source: JSON.stringify({ ...base, scripts: complete.scripts }),
      outcome: 'write',
    },
    {
      name: 'adds only the script to an existing dependency',
      source: JSON.stringify({ devDependencies: complete.devDependencies }),
      outcome: 'write',
    },
    {
      name: 'leaves a complete manifest byte-for-byte',
      source: JSON.stringify(complete),
      outcome: 'noop',
    },
    {
      name: 'leaves a complete BOM manifest byte-for-byte',
      source: '\uFEFF' + JSON.stringify(complete),
      outcome: 'noop',
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const result = planNodeDevtool(row.source);
      if (row.outcome === 'refuse') {
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining(row.message!) });
      } else {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        if (row.outcome === 'noop') expect(result.contents).toBeUndefined();
        else {
          expect(result.contents).toBeDefined();
          const written = JSON.parse(result.contents!);
          expect(written.scripts.dev).toBe(NODE_DEVTOOL_DEV_SCRIPT);
          expect(written.devDependencies[plugin]).toBe(FRAMEWORK_RANGE);
          expect(written.dependencies?.[plugin]).toBeUndefined();
          expect(planNodeDevtool(result.contents!)).toEqual({ ok: true });
        }
      }
    });
  }

  it('names every mismatched pin and the upgrade guide, escaping terminal controls', () => {
    const result = planNodeDevtool(
      JSON.stringify({
        ...base,
        dependencies: { '@setu-ts/common': '^0.1.0\nCANARY' },
        devDependencies: { ...base.devDependencies, '@setu-ts/cli': 'latest' },
      }),
      'apps/a\nBAD/package.json',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.message).toContain('docs/upgrading.md');
    expect(result.message).toContain('@setu-ts/common');
    expect(result.message).toContain('@setu-ts/cli');
    expect(result.message).not.toContain('\nCANARY');
    expect(result.message).not.toContain('\nBAD');
  });

  it('preserves unrelated keys, scripts and dependencies and ignores root overrides', () => {
    const extra = {
      ...base,
      scripts: { check: 'my-check', start: 'my-start' },
      dependencies: { '@setu-ts/common': FRAMEWORK_RANGE, other: '1.0.0' },
      overrides: { '@setu-ts/common': 'workspace:*' },
      private: true,
    };
    const result = planNodeDevtool(JSON.stringify(extra));
    if (!result.ok || result.contents === undefined) throw new Error('expected a write');
    expect(JSON.parse(result.contents)).toMatchObject(extra);
  });
});
