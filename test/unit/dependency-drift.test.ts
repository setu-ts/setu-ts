import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import {
  findDependencyDrift,
  formatDependencyDrift,
  packageNameOf,
  runDependencyDriftMain,
} from '../../scripts/dependency-drift.ts';
describe('pnpm dependency drift', () => {
  it('reads two YAML locks through the command path and refuses incomplete arguments', async () => {
    await mkdir('.tmp', { recursive: true });
    const dir = await mkdtemp('.tmp/dependency-drift-');
    try {
      await writeFile(
        `${dir}/before.yaml`,
        "lockfileVersion: '9.0'\npackages: { a@1.0.0: {resolution: {integrity: before}} }",
      );
      await writeFile(
        `${dir}/after.yaml`,
        "lockfileVersion: '9.0'\npackages: { a@2.0.0: {resolution: {integrity: after}} }",
      );
      expect(await runDependencyDriftMain([])).toBe(2);
      expect(await runDependencyDriftMain([`${dir}/before.yaml`])).toBe(2);
      expect(await runDependencyDriftMain([`${dir}/before.yaml`, `${dir}/after.yaml`])).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it('reads scoped and unscoped package keys', () => {
    expect(packageNameOf('@scope/a@1.0.0')).toBe('@scope/a');
    expect(packageNameOf('zod@4.4.3')).toBe('zod');
    expect(packageNameOf('unversioned')).toBe('unversioned');
  });
  it('reports added, removed, changed and unchanged packages including multiple resolutions', () => {
    const before = parse(
      'packages:\n  zod@4.4.3: {}\n  removed@1.0.0: {}\n  same@1.0.0: {}\n  same@2.0.0: {}\n',
    );
    const after = parse(
      'packages:\n  added@1.0.0: {}\n  zod@4.5.0: {}\n  same@2.0.0: {}\n  same@1.0.0: {}\n',
    );
    const changes = findDependencyDrift(before, after);
    expect(changes).toEqual([
      { specifier: 'added', packageName: 'added', previous: null, current: '1.0.0' },
      { specifier: 'removed', packageName: 'removed', previous: '1.0.0', current: null },
      { specifier: 'zod', packageName: 'zod', previous: '4.4.3', current: '4.5.0' },
    ]);
    const text = formatDependencyDrift(changes);
    expect(text).toContain('| `added` | `added` | `not locked` | `1.0.0` |');
    expect(text).toContain('| `removed` | `removed` | `1.0.0` | `removed` |');
    expect(text).toContain('| `zod` | `zod` | `4.4.3` | `4.5.0` |');
    expect(findDependencyDrift({}, {})).toEqual([]);
    expect(formatDependencyDrift([])).toBe(
      '## Dependency drift\n\nNo dependency resolution changed.\n',
    );
  });
});
