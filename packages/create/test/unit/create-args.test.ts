import { describe, expect, it } from 'vitest';
import { createArgs } from '../../src/index.ts';

describe('createArgs', () => {
  it('turns `npm create @setu-ts <name> -- <flags>` into a setu new invocation', () => {
    expect(createArgs(['shop', '--template', 'rest'])).toEqual([
      'new',
      'shop',
      '--template',
      'rest',
    ]);
  });

  it('passes an empty invocation to setu new, which reports what it needs', () => {
    expect(createArgs([])).toEqual(['new']);
  });

  it('never mutates the caller argument list', () => {
    const argv = Object.freeze(['shop']);
    expect(createArgs(argv)).toEqual(['new', 'shop']);
  });
});
