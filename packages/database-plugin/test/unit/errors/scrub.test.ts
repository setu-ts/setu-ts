import { describe, expect, it } from 'vitest';
import { scrubDriverError } from '../../../src/errors/scrub.ts';

function queryError(cause?: unknown): Error & { query: string; params: unknown[] } {
  return Object.assign(
    new Error(
      'Failed query: select $1\nparams: private-email',
      cause === undefined ? undefined : { cause },
    ),
    {
      query: 'select $1',
      params: ['private-email'],
      stack:
        'Error: Failed query: select $1\nparams: private-email\n    at query (driver.js:1:2)\n    at run (app.js:2:3)',
    },
  );
}

describe('scrubDriverError', () => {
  it('keeps SQL, frames, name and cause, and drops the entire multiline header and params', () => {
    const cause = Object.assign(new Error('driver rejected'), { code: '40001' });
    const original = queryError(cause);
    original.name = 'DrizzleQueryError';
    const clean = scrubDriverError(original) as Error & { query: string };
    expect(clean).not.toBe(original);
    expect(clean.message).toBe('Failed query: select $1');
    expect(clean.stack).toBe(
      'Failed query: select $1\n    at query (driver.js:1:2)\n    at run (app.js:2:3)',
    );
    expect(clean.name).toBe(original.name);
    expect(clean.query).toBe('select $1');
    expect(Object.hasOwn(clean, 'params')).toBe(false);
    expect(clean.cause).toBe(cause);
    expect(original.message).toContain('private-email');
  });

  it('uses just the clean message when frames or stack are absent', () => {
    for (const stack of ['header\nparams: private-email', undefined]) {
      const error = queryError();
      if (stack === undefined) delete error.stack;
      else error.stack = stack;
      expect((scrubDriverError(error) as Error).stack).toBe('Failed query: select $1');
    }
  });

  it('returns non-Drizzle shapes unchanged', () => {
    const inherited = Object.create({ query: 'select $1', params: [] }) as object;
    for (const error of [
      null,
      'failed',
      1,
      {},
      new Error('ordinary'),
      inherited,
      Object.assign(new Error('Failed query: x'), { query: 1, params: [] }),
      Object.assign(new Error('Failed query: x'), { query: 'x', params: 'secret' }),
      Object.assign(new Error('ordinary'), { query: 'x', params: [] }),
      Object.assign(new Error('Failed query: x'), { query: 'x' }),
    ])
      expect(scrubDriverError(error)).toBe(error);
  });

  it('scrubs nested query nodes while retaining ordinary driver nodes', () => {
    const driver = new Error('driver');
    const inner = queryError(driver);
    const outer = queryError(inner);
    const clean = scrubDriverError(outer) as Error;
    expect(clean.cause).not.toBe(inner);
    expect((clean.cause as Error).cause).toBe(driver);
    const wrapper = new Error('wrapper', { cause: queryError(driver) });
    expect(scrubDriverError(wrapper)).toBe(wrapper);
    expect((wrapper.cause as Error).message).toBe('Failed query: select $1');
  });

  it('uses the classifier depth bound and terminates cyclic chains', () => {
    const beyond = queryError();
    let head: Error = beyond;
    for (let n = 0; n < 5; n++) head = new Error('wrapper', { cause: head });
    expect(scrubDriverError(head)).toBe(head);
    expect(beyond.message).toContain('private-email');
    const cyclic = new Error('cycle');
    cyclic.cause = cyclic;
    expect(scrubDriverError(cyclic)).toBe(cyclic);
  });

  it('preserves scalar causes and relinks query cycles exclusively to scrubbed nodes', () => {
    const scalar = scrubDriverError(queryError('driver rejected')) as Error;
    expect(scalar.cause).toBe('driver rejected');
    const self = queryError();
    self.cause = self;
    const clean = scrubDriverError(self) as Error;
    expect(clean.cause).toBe(clean);
    expect(clean.message).not.toContain('private-email');
    const a = queryError();
    const b = queryError(a);
    a.cause = b;
    const pair = scrubDriverError(a) as Error;
    expect((pair.cause as Error).cause).toBe(pair);
    expect((pair.cause as Error).message).not.toContain('private-email');
  });

  it('copies a frozen wrapper instead of throwing, so the error path never becomes the fault', () => {
    const outer = Object.freeze(
      Object.assign(new Error('wrapper', { cause: queryError() }), { code: 'E_WRAP' }),
    );
    const clean = scrubDriverError(outer) as Error & { code?: string };
    expect(clean).not.toBe(outer);
    expect(clean.message).toBe('wrapper');
    expect(clean.code).toBe('E_WRAP');
    expect((clean.cause as Error).message).toBe('Failed query: select $1');
    expect(JSON.stringify(clean.cause)).not.toContain('private-email');
    expect((outer.cause as Error).message).toContain('private-email');
  });
});
