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

  it('rebuilds a SQLSTATE class 22 cause from its code, dropping the quoted input', () => {
    const pg = Object.assign(new Error('invalid input syntax for type uuid: "canary-22p02"'), {
      code: '22P02',
      severity: 'ERROR',
      where: "unnamed portal parameter $1 = 'canary-22p02'",
      stack: 'error: invalid input syntax for type uuid: "canary-22p02"\n    at parse (pg.js:1:1)',
    });
    const clean = scrubDriverError(queryError(pg)) as Error;
    const cause = clean.cause as Error & { code?: string; severity?: string };
    expect(cause.message).toBe('Data exception (SQLSTATE 22P02)');
    expect(cause.stack).toBe('Data exception (SQLSTATE 22P02)\n    at parse (pg.js:1:1)');
    expect(cause.code).toBe('22P02');
    expect(cause.severity).toBe('ERROR');
    expect(JSON.stringify({ ...cause, m: cause.message, s: cause.stack })).not.toContain(
      'canary-22p02',
    );
  });

  it('leaves non-class-22 codes and code-less errors untouched', () => {
    for (const code of ['23505', '40001', 'ER_DUP_ENTRY', '2200', '22p02']) {
      const node = Object.assign(new Error(`keep ${code}`), { code });
      expect(scrubDriverError(node)).toBe(node);
    }
  });

  it('returns normally when a driver error accessor throws (R2-F5)', () => {
    const throwing = (target: Error, key: string): Error =>
      Object.defineProperty(target, key, {
        get() {
          throw new Error(`accessor ${key}`);
        },
      });
    for (const key of ['code', 'stack', 'severity', 'message', 'name']) {
      const node = Object.assign(new Error('invalid input syntax for type uuid: "canary-r2"'), {
        code: '22P02',
        severity: 'ERROR',
      });
      throwing(node, key);
      expect(() => scrubDriverError(queryError(node))).not.toThrow();
    }
    // A data exception whose stack throws still loses the quoted value.
    const stackless = throwing(
      Object.assign(new Error('invalid input syntax for type uuid: "canary-r2"'), {
        code: '22P02',
      }),
      'stack',
    );
    const cause = (scrubDriverError(queryError(stackless)) as Error).cause as Error;
    expect(cause.message).toBe('Data exception (SQLSTATE 22P02)');
    expect(cause.stack).toBe('Data exception (SQLSTATE 22P02)');
    // A Drizzle wrapper whose stack throws is scrubbed with no frames.
    const wrapper = throwing(queryError(), 'stack');
    expect((scrubDriverError(wrapper) as Error).stack).toBe('Failed query: select $1');
    // A frozen wrapper with a throwing own getter is copied without throwing.
    const frozen = Object.freeze(
      Object.defineProperty(new Error('wrapper', { cause: queryError() }), 'detail', {
        enumerable: true,
        get() {
          throw new Error('accessor detail');
        },
      }),
    );
    const copy = scrubDriverError(frozen) as Error & { detail?: unknown };
    expect(copy).not.toBe(frozen);
    expect(copy.detail).toBeUndefined();
  });
});

describe('scrubDriverError — a frame-shaped line inside a bound value (M113g audit L6)', () => {
  const forgedValue = 'x\n    at FORGED_FRAME (evil.js:1:1)';

  it('drops a forged frame and every later header line, keeping the real frames', () => {
    const message = `Failed query: select $1, $2\nparams: ${forgedValue},private-key`;
    const original = Object.assign(new Error(message), {
      query: 'select $1, $2',
      params: [forgedValue, 'private-key'],
      stack: `DrizzleQueryError: ${message}\n    at query (driver.js:1:2)`,
    });
    const clean = scrubDriverError(original) as Error;
    expect(clean.stack).toBe('Failed query: select $1, $2\n    at query (driver.js:1:2)');
    expect(clean.stack).not.toContain('FORGED_FRAME');
    expect(clean.stack).not.toContain('private-key');
  });

  it('drops a forged frame from a class 22 data exception header', () => {
    const message = `invalid input syntax for type integer: "${forgedValue}"`;
    const pg = Object.assign(new Error(message), {
      code: '22P02',
      stack: `error: ${message}\n    at parse (pg.js:3:4)`,
    });
    const clean = scrubDriverError(pg) as Error;
    expect(clean.stack).toBe('Data exception (SQLSTATE 22P02)\n    at parse (pg.js:3:4)');
  });

  it('keeps no frames when the original message is not on the stack', () => {
    const pg = Object.assign(new Error('value "private"'), {
      code: '22P02',
      stack: 'unrelated header\n    at parse (pg.js:3:4)',
    });
    expect((scrubDriverError(pg) as Error).stack).toBe('Data exception (SQLSTATE 22P02)');
  });

  it('keeps the frames of an error whose message is empty', () => {
    const pg = Object.assign(new Error(''), {
      code: '22P02',
      stack: 'error\n    at parse (pg.js:3:4)',
    });
    expect((scrubDriverError(pg) as Error).stack).toBe(
      'Data exception (SQLSTATE 22P02)\n    at parse (pg.js:3:4)',
    );
  });
});
