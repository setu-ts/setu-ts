import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  findDependencyDrift,
  formatDependencyDrift,
  packageNameOf,
} from '../../scripts/dependency-drift.ts';

describe('dependency drift', () => {
  it('attributes npm and JSR specifiers to their packages', () => {
    expect(packageNameOf('npm:@scope/package@^1')).toBe('@scope/package');
    expect(packageNameOf('npm:zod@^4')).toBe('zod');
    expect(packageNameOf('jsr:@std/expect@^1')).toBe('@std/expect');
    expect(packageNameOf('https://example.test/module.ts')).toBe('https://example.test/module.ts');
  });

  it('reports changed and newly resolved ranges in specifier order', () => {
    const changes = findDependencyDrift(
      { specifiers: { 'npm:zod@^4': '4.4.3', 'npm:removed@1': '1.0.0' } },
      { specifiers: { 'npm:added@1': '1.0.0', 'npm:zod@^4': '4.5.0' } },
    );

    expect(changes).toEqual([
      {
        specifier: 'npm:added@1',
        packageName: 'added',
        previous: null,
        current: '1.0.0',
      },
      {
        specifier: 'npm:zod@^4',
        packageName: 'zod',
        previous: '4.4.3',
        current: '4.5.0',
      },
    ]);
  });

  it('renders package names and exact old-to-new resolutions', () => {
    const report = formatDependencyDrift([
      {
        specifier: 'npm:zod@^4',
        packageName: 'zod',
        previous: '4.4.3',
        current: '4.5.0',
      },
    ]);

    expect(report).toContain('| `zod` | `npm:zod@^4` | `4.4.3` | `4.5.0` |');
  });

  it('has an explicit no-drift report', () => {
    expect(formatDependencyDrift([])).toBe(
      '## Dependency drift\n\nNo direct dependency resolution changed.\n',
    );
  });
});
