import { describe, expect, it } from 'vitest';

import type { CommandRunner } from '../../../src/utils/run-command.ts';
import {
  defaultImageTag,
  imageReference,
  isValidImageTag,
  timestampTag,
} from '../../../src/workspace/image-tag.ts';

function git(
  head: { code: number; stdout: string },
  status = { code: 0, stdout: '' },
): CommandRunner {
  return (_command, args) =>
    Promise.resolve({ ...(args[0] === 'rev-parse' ? head : status), stderr: '' });
}

describe('image tags', () => {
  it('accepts Docker tag grammar only', () => {
    for (const tag of ['v1', '_x', 'abc1234-dirty', 'a'.repeat(128)])
      expect(isValidImageTag(tag), tag).toBe(true);
    for (const tag of ['', '-x', '.x', 'a/b', 'a:b', 'a'.repeat(129)])
      expect(isValidImageTag(tag), tag).toBe(false);
  });

  it('formats a UTC timestamp tag', () => {
    expect(timestampTag(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('build-20260102030405');
  });

  it('uses the short commit, -dirty with changes, and the timestamp outside a repository', async () => {
    const now = () => Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(await defaultImageTag(git({ code: 0, stdout: 'abc1234\n' }), '/ws', now)).toBe(
      'abc1234',
    );
    expect(
      await defaultImageTag(
        git({ code: 0, stdout: 'abc1234\n' }, { code: 0, stdout: '?? x\n' }),
        '/ws',
        now,
      ),
    ).toBe('abc1234-dirty-20260102030405');
    // A status that cannot be read is treated as dirty, never as clean.
    expect(
      await defaultImageTag(
        git({ code: 0, stdout: 'abc1234\n' }, { code: 128, stdout: '' }),
        '/ws',
        now,
      ),
    ).toBe('abc1234-dirty-20260102030405');
    expect(await defaultImageTag(git({ code: 128, stdout: '' }), '/ws', now)).toBe(
      'build-20260102030405',
    );
    // A repository with no commit yet prints nothing usable.
    expect(await defaultImageTag(git({ code: 0, stdout: '' }), '/ws', now)).toBe(
      'build-20260102030405',
    );
  });

  it('builds references with and without a registry', () => {
    expect(imageReference('orders', 'v1')).toBe('orders:v1');
    expect(imageReference('orders', 'v1', 'ghcr.io/acme')).toBe('ghcr.io/acme/orders:v1');
    expect(imageReference('orders', 'v1', 'ghcr.io/acme/')).toBe('ghcr.io/acme/orders:v1');
  });
});
