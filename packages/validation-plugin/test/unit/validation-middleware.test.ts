/**
 * Unit tests for validation middleware.
 *
 * Covers extractTarget for all 5 targets, createValidationMiddleware success/
 * failure paths, short-circuit behavior, JSON parse errors, and cookie decoding.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IValidationService, ValidationTarget } from '@setu-ts/common';
import { validatedStateKey } from '@setu-ts/common';

import { createValidationMiddleware } from '../../src/middleware/validation-middleware.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';
import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';
import { rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { resolveFormatter } from '../../src/formatters/error-formatter.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeSchema(opts: {
  success?: boolean;
  data?: unknown;
  issues?: { path?: (string | number)[]; message: string; code?: string }[];
}) {
  return {
    safeParse(_data: unknown) {
      if (opts.success ?? true) {
        return { success: true as const, data: opts.data ?? _data };
      }
      return {
        success: false as const,
        error: { issues: opts.issues ?? [] },
      };
    },
  };
}

const SERVICE: IValidationService = new ValidationService(defaultFormatter);

/** Mutable next-callback that satisfies NextFunction (returns Promise<void>). */
function createNextFn(): { called: boolean; fn: () => Promise<void> } {
  let called = false;
  return {
    get called() {
      return called;
    },
    fn: () => {
      called = true;
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// createValidationMiddleware — success paths
// ---------------------------------------------------------------------------

describe('createValidationMiddleware — success stores validated data and calls next', () => {
  it('body target stores validatedStateKey(body) and calls next', async () => {
    const schema = createFakeSchema({ success: true, data: { name: 'Alice' } });
    const { ctx, responseSnapshot } = createFakeContext({
      request: { body: { name: 'Alice' } },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'body', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    expect(ctx.state.get(validatedStateKey('body'))).toEqual({ name: 'Alice' });
    const snap = responseSnapshot();
    expect(snap.body).toBe(null);
  });

  it('query target stores validatedStateKey(query) and calls next', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({ query: { page: '1' } });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'query', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    expect(ctx.state.has(validatedStateKey('query'))).toBe(true);
  });

  it('params target stores validatedStateKey(params) and calls next', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({ params: { id: '42' } });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'params', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    expect(ctx.state.has(validatedStateKey('params'))).toBe(true);
  });

  it('headers target stores validatedStateKey(headers) and calls next', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({ request: { headers: { 'x-api-key': 'secret' } } });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'headers', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    expect(ctx.state.has(validatedStateKey('headers'))).toBe(true);
  });

  it('cookies target stores validatedStateKey(cookies) and calls next', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({
      request: { headers: { cookie: 'session=abc123' } },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'cookies', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    expect(ctx.state.has(validatedStateKey('cookies'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Short-circuit: next() NOT called on validation failure
// ---------------------------------------------------------------------------

describe('createValidationMiddleware — short-circuit on failure', () => {
  it('next() is NOT called when validation fails', async () => {
    const schema = createFakeSchema({
      success: false,
      issues: [{ path: ['name'], message: 'Required' }],
    });
    const { ctx, responseSnapshot } = createFakeContext({
      request: { body: {} },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'body', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(false);
    const snap = responseSnapshot();
    expect(snap.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// JSON parse error
// ---------------------------------------------------------------------------

describe('createValidationMiddleware — JSON parse error', () => {
  it('returns 400 with formatted issue when body JSON is invalid', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx, responseSnapshot } = createFakeContext({
      request: { bodyError: true },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'body', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    const snap = responseSnapshot();
    expect(snap.status).toBe(400);
    const body = JSON.parse(snap.body!);
    expect(body.errors[0].field).toBe('');
    expect(body.errors[0].message).toBe('Invalid JSON in request body');
  });
});

// ---------------------------------------------------------------------------
// __jsonParseError key is valid data (sentinel bug regression)
// ---------------------------------------------------------------------------

describe('createValidationMiddleware — __jsonParseError key', () => {
  it('treats body with __jsonParseError key as valid data', async () => {
    const schema = createFakeSchema({
      success: true,
      data: { __jsonParseError: 'sentinel' },
    });
    const { ctx } = createFakeContext({
      request: { body: { __jsonParseError: 'sentinel' } },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'body', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    expect(ctx.state.get(validatedStateKey('body'))).toEqual({ __jsonParseError: 'sentinel' });
  });
});

// ---------------------------------------------------------------------------
// Cookie decoding
// ---------------------------------------------------------------------------

describe('extractTarget — cookies', () => {
  it('decodes percent-encoded cookie values', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({
      request: { headers: { cookie: 'name=%48%65%6C%6C%6F' } },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'cookies', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    const cookies = ctx.state.get(validatedStateKey('cookies')) as Record<string, string>;
    expect(cookies.name).toBe('Hello');
  });

  it('falls back to raw value for malformed percent sequences', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({
      request: { headers: { cookie: 'name=%ZZ' } },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'cookies', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    const cookies = ctx.state.get(validatedStateKey('cookies')) as Record<string, string>;
    expect(cookies.name).toBe('%ZZ');
  });

  it('returns empty object when no cookie header', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext();
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'cookies', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    expect(ctx.state.get(validatedStateKey('cookies'))).toEqual({});
  });

  it('skips empty cookie segments and parses the real cookies', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({
      request: { headers: { cookie: 'a=1;;b=2' } },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'cookies', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    const cookies = ctx.state.get(validatedStateKey('cookies')) as Record<string, string>;
    expect(cookies).toEqual({ a: '1', b: '2' });
  });

  it('treats a cookie pair with no "=" as a flag-style key with empty value', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext({
      request: { headers: { cookie: 'flag;a=1' } },
    });
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(schema, 'cookies', SERVICE, defaultFormatter);

    await middleware(ctx, nextFn.fn);

    expect(nextFn.called).toBe(true);
    const cookies = ctx.state.get(validatedStateKey('cookies')) as Record<string, string>;
    expect(cookies).toEqual({ flag: '', a: '1' });
  });
});

// ---------------------------------------------------------------------------
// Unknown target — extractTarget default throw + createValidationMiddleware rethrow
// ---------------------------------------------------------------------------

describe('createValidationMiddleware — unknown target', () => {
  it('throws TypeError for an unknown target and never calls next', async () => {
    const schema = createFakeSchema({ success: true });
    const { ctx } = createFakeContext();
    const nextFn = createNextFn();
    const middleware = createValidationMiddleware(
      schema,
      'bogus' as unknown as Parameters<typeof createValidationMiddleware>[1],
      SERVICE,
      defaultFormatter,
    );

    await expect(middleware(ctx, nextFn.fn)).rejects.toThrow(TypeError);
    await expect(middleware(ctx, nextFn.fn)).rejects.toThrow('Unknown validation target');
    expect(nextFn.called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Problem Details media type — keyed on the RESOLVED formatter, not the alias
// ---------------------------------------------------------------------------

describe('createValidationMiddleware — Problem Details media type', () => {
  /** Drives a failing validation and returns the response content type. */
  async function contentTypeFor(
    formatter: Parameters<typeof createValidationMiddleware>[3],
  ): Promise<string | null> {
    const schema = createFakeSchema({
      success: false,
      issues: [{ path: ['name'], message: 'Required' }],
    });
    const { ctx, responseSnapshot } = createFakeContext({ request: { body: {} } });
    const middleware = createValidationMiddleware(schema, 'body', SERVICE, formatter);

    await middleware(ctx, createNextFn().fn);
    return responseSnapshot().headers.get('content-type');
  }

  // `errorFormat` accepts a formatter reference as well as an alias, so keying
  // the media type on the format STRING would let a reference emit a Problem
  // Details body as `application/json` — which generic problem-details clients
  // ignore. A string-only test cannot see that.
  it('serves problem+json for the rfc9457Formatter reference', async () => {
    expect(await contentTypeFor(rfc9457Formatter)).toBe('application/problem+json');
  });

  it('serves problem+json for the deprecated rfc7807Formatter reference', async () => {
    expect(await contentTypeFor(rfc7807Formatter)).toBe('application/problem+json');
  });

  it('serves problem+json for both resolved aliases', async () => {
    expect(await contentTypeFor(resolveFormatter('rfc9457'))).toBe('application/problem+json');
    expect(await contentTypeFor(resolveFormatter('rfc7807'))).toBe('application/problem+json');
  });

  it('does NOT serve problem+json for the default formatter', async () => {
    expect(await contentTypeFor(defaultFormatter)).not.toBe('application/problem+json');
  });

  it('does NOT serve problem+json for a custom formatter', async () => {
    expect(await contentTypeFor(() => ({ errors: [] }))).not.toBe('application/problem+json');
  });
});

// ---------------------------------------------------------------------------
// Shared state key — the middleware must write through `validatedStateKey`,
// never an inline literal, so readers in other packages cannot drift (M70n)
// ---------------------------------------------------------------------------
describe('createValidationMiddleware — writes the shared validatedStateKey', () => {
  const TARGETS: readonly ValidationTarget[] = ['body', 'query', 'params', 'headers', 'cookies'];

  for (const target of TARGETS) {
    it(`stores the validated value under validatedStateKey('${target}')`, async () => {
      const schema = createFakeSchema({ success: true, data: { ok: true } });
      const { ctx } = createFakeContext({
        request: target === 'body'
          ? { body: { ok: true } }
          : target === 'cookies'
          ? { headers: { cookie: 'session=abc' } }
          : target === 'headers'
          ? { headers: { 'x-api-key': 'k' } }
          : {},
        ...(target === 'query' ? { query: { page: '1' } } : {}),
        ...(target === 'params' ? { params: { id: '1' } } : {}),
      });
      const nextFn = createNextFn();
      const middleware = createValidationMiddleware(schema, target, SERVICE, defaultFormatter);

      await middleware(ctx, nextFn.fn);

      expect(nextFn.called).toBe(true);
      // The key the middleware wrote MUST be the one `validatedStateKey`
      // builds — this is what stops the writer here and a reader in another
      // package from disagreeing byte-for-byte.
      expect(ctx.state.has(validatedStateKey(target))).toBe(true);
    });
  }

  it('pins the released wire format of the helper itself', () => {
    // Guarding the guard: if someone reintroduces an inline literal with a
    // different prefix, the assertions above fail; this pins that the helper
    // still produces the released `validated:<target>` key.
    expect(validatedStateKey('body')).toBe('validation-plugin:validated-body');
  });
});
