import { describe, expect, it } from 'vitest';
import { SANDBOX_READ_PATHS, sandboxReadFlags } from '../../scripts/lib/sandbox.ts';

describe('documentation sandbox read grants', () => {
  it('grants the import paths and any extra path, resolved against the root', () => {
    expect(sandboxReadFlags('/repo', ['.tmp/scratch'])).toEqual([
      ...SANDBOX_READ_PATHS.map((path) => `--allow-fs-read=/repo/${path}`),
      '--allow-fs-read=/repo/.tmp/scratch',
    ]);
  });

  it('never grants the repository root, .git or an environment file', () => {
    expect(SANDBOX_READ_PATHS).not.toContain('.');
    expect(
      SANDBOX_READ_PATHS.some((path) => path.startsWith('.git') || path.includes('.env')),
    ).toBe(false);
  });
});
