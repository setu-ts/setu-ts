import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('local storage on Bun', () => {
  it('absent keys return null/false and filesystem errors retain ENOENT', (context) => {
    const result = spawnSync(
      'bun',
      [new URL('../fixtures/bun-local-absence.ts', import.meta.url).pathname],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') context.skip();
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
