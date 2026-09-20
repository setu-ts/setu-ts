import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { isMissingPath } from '../../src/utils/filesystem-errors.ts';

describe('missing-path classification', () => {
  it('recognizes the three runtime adapters and refuses unrelated failures', () => {
    const deno = new Error('missing');
    deno.name = 'NotFound';
    const node = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const cases: readonly [unknown, boolean][] = [
      [deno, true],
      [node, true],
      [new Error("ENOENT: no such file or directory, read 'x'"), true],
      [Object.assign(new Error('denied'), { code: 'EACCES' }), false],
      [new Error('disk full'), false],
      ['ENOENT', false],
      [null, false],
    ];
    for (const [cause, missing] of cases) expect(isMissingPath(cause)).toBe(missing);
  });
});
