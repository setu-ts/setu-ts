/**
 * Tests that exercise the REAL `@hono/hono` import inside the Router.
 *
 * These tests assert the `Router` → Hono → `{ definition, params }` mapping
 * directly: identity of returned definition, param extraction, static-over-param
 * preference, no-match → null, and the §3.6 tie-break.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { Router } from '../../src/router/router.ts';

describe('Hono router bridge — definition identity', () => {
  it('match() returns the SAME definition object the caller registered', () => {
    const router = new Router();
    const handler = () => ({ __handlerResult: true }) as never;
    const definition = { handler };
    router.get('/users/:id', definition);

    const result = router.match('GET', '/users/123');
    expect(result).not.toBe(null);
    expect(result!.definition).toBe(definition);
  });
});

describe('Hono router bridge — param extraction', () => {
  it('extracts single param: /users/:id → { id: "123" }', () => {
    const router = new Router();
    router.get('/users/:id', () => ({ __handlerResult: true }) as never);
    const result = router.match('GET', '/users/123');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({ id: '123' });
  });

  it('extracts multiple params: /users/:userId/posts/:postId', () => {
    const router = new Router();
    router.get(
      '/users/:userId/posts/:postId',
      () =>
        ({
          __handlerResult: true,
        }) as never,
    );
    const result = router.match('GET', '/users/123/posts/456');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({ userId: '123', postId: '456' });
  });

  it('extracts string params (not coerced to numbers)', () => {
    const router = new Router();
    router.get('/items/:id', () => ({ __handlerResult: true }) as never);
    const result = router.match('GET', '/items/99');
    expect(result).not.toBe(null);
    expect(typeof result!.params.id).toBe('string');
    expect(result!.params.id).toBe('99');
  });
});

describe('Hono router bridge — static-over-param', () => {
  it('prefers static /users/me over param /users/:id', () => {
    const router = new Router();
    router.get('/users/:id', () => ({ __handlerResult: true }) as never);
    router.get('/users/me', () => ({ __handlerResult: true }) as never);
    const result = router.match('GET', '/users/me');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({});
  });
});

describe('Hono router bridge — no match returns null', () => {
  it('returns null when no route matches the path', () => {
    const router = new Router();
    router.get('/users', () => ({ __handlerResult: true }) as never);
    const result = router.match('GET', '/posts');
    expect(result).toBe(null);
  });

  it('returns null when method does not match', () => {
    const router = new Router();
    router.get('/users', () => ({ __handlerResult: true }) as never);
    const result = router.match('POST', '/users');
    expect(result).toBe(null);
  });
});

describe('Hono router bridge — §3.6 tie-break deterministic', () => {
  it('breaks ties by earliest registration order', () => {
    const router = new Router();
    const defX = { handler: () => ({ __handlerResult: true }) as never };
    const defY = { handler: () => ({ __handlerResult: true }) as never };
    router.get('/a/:x', defX);
    router.get('/a/:y', defY);

    const result = router.match('GET', '/a/123');
    expect(result).not.toBe(null);
    // /a/:x was registered first → wins tie-break
    expect(result!.params).toEqual({ x: '123' });
    expect(result!.definition).toBe(defX);
  });
});

describe('Hono router bridge — trailing slash parity', () => {
  it('/users/ matches /users route (strict: false)', () => {
    const router = new Router();
    router.get('/users', () => ({ __handlerResult: true }) as never);
    const result = router.match('GET', '/users/');
    expect(result).not.toBe(null);
  });

  it('/users/123/ matches /users/:id route (strict: false)', () => {
    const router = new Router();
    router.get('/users/:id', () => ({ __handlerResult: true }) as never);
    const result = router.match('GET', '/users/123/');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({ id: '123' });
  });

  it('a route registered with a trailing slash answers only that spelling', () => {
    const router = new Router();
    const def = { handler: () => ({ __handlerResult: true }) as never };
    router.get('/api/docs/', def);
    expect(router.match('GET', '/api/docs/')?.definition).toBe(def);
    expect(router.match('GET', '/api/docs')).toBe(null);
    expect(router.getAll()[0]!.pattern).toBe('/api/docs/');
  });

  it('resolves overlapping slash-terminated routes without losing their entries', () => {
    const router = new Router();
    const byId = { handler: () => ({ __handlerResult: true }) as never };
    const me = { handler: () => ({ __handlerResult: true }) as never };
    router.get('/users/:id/', byId);
    router.get('/users/me/', me);
    expect(router.match('GET', '/users/me/')?.definition).toBe(me);
    expect(router.match('GET', '/users/42/')?.params).toEqual({ id: '42' });
    // A parameter pattern's trailing slash is not significant (LinearRouter's
    // rule before 0.11.0), so the slashless path reaches the parameter route.
    expect(router.match('GET', '/users/me')?.definition).toBe(byId);
  });

  it('lets a parameter route registered with a trailing slash answer the slashless path', () => {
    const router = new Router();
    router.get('/users/:id/', () => ({ __handlerResult: true }) as never);
    expect(router.match('GET', '/users/42')?.params).toEqual({ id: '42' });
    expect(router.match('GET', '/users/42/')?.params).toEqual({ id: '42' });
  });

  // Re-audit N1: the trailing-slash spelling ranks every candidate together,
  // so a wildcard cannot win over the specific route that carries a guard.
  it.each([
    ['/admin', '/admin/*', '/admin/'],
    ['/api/v1/items', '/*', '/api/v1/items/'],
    ['/openapi.json', '/*', '/openapi.json/'],
  ])('prefers %s over %s for %s', (specific, wildcard, request) => {
    const router = new Router();
    const guarded = {
      middleware: [(_ctx: never, _next: never) => Promise.resolve()],
      handler: () => ({ __handlerResult: true }) as never,
    };
    const catchAll = { handler: () => ({ __handlerResult: true }) as never };
    router.get(wildcard, catchAll);
    router.get(specific, guarded as never);
    expect(router.match('GET', request)?.definition).toBe(guarded);
  });

  it('keeps /a and /a/ as two reachable routes', () => {
    const router = new Router();
    const bare = { handler: () => ({ __handlerResult: true }) as never };
    const slash = { handler: () => ({ __handlerResult: true }) as never };
    router.get('/a/', slash);
    router.get('/a', bare);
    expect(router.match('GET', '/a')?.definition).toBe(bare);
    expect(router.match('GET', '/a/')?.definition).toBe(slash);
  });

  it('does not retry the root, which has no slash to drop', () => {
    const router = new Router();
    router.get('/users', () => ({ __handlerResult: true }) as never);
    expect(router.match('GET', '/')).toBe(null);
  });
});

// C1 regression — same-path-different-method must return correct definition identity
describe('C1 regression — same path, different methods', () => {
  it('match(GET, /api/users) returns the GET definition, not POST', () => {
    const router = new Router();
    const getDef = { handler: () => ({ __handlerResult: true }) as never };
    const postDef = { handler: () => ({ __handlerResult: true }) as never };
    router.get('/api/users', getDef);
    router.post('/api/users', postDef);

    const getResult = router.match('GET', '/api/users');
    expect(getResult).not.toBe(null);
    expect(getResult!.definition).toBe(getDef);
    expect(getResult!.params).toEqual({});

    const postResult = router.match('POST', '/api/users');
    expect(postResult).not.toBe(null);
    expect(postResult!.definition).toBe(postDef);
    expect(postResult!.params).toEqual({});
  });
});

// Security audit F2: TrieRouter's cost for a `:name{…}` constraint that can
// match '/' grows quadratically with the path, so the syntax is refused.
describe('regular-expression route parameters', () => {
  it.each(['/files/:path{.+}/download', '/users/:id{[0-9]+}', '/:slug{[a-z-]+}/edit'])(
    'refuses %s at registration',
    (pattern) => {
      const router = new Router();
      expect(() => router.get(pattern, () => ({ __handlerResult: true }) as never)).toThrow(
        `Route 'GET ${pattern}' uses a regular-expression parameter (':name{…}')`,
      );
      expect(router.getAll()).toEqual([]);
    },
  );

  it('refuses one written without a leading slash', () => {
    const router = new Router();
    expect(() =>
      router.get(':path{.+}/download', () => ({ __handlerResult: true }) as never),
    ).toThrow("uses a regular-expression parameter (':name{…}')");
  });

  it('refuses one registered through a group prefix', () => {
    const router = new Router();
    expect(() =>
      router.group('/api', (api) => {
        api.post('/items/:id{\\d+}', () => ({ __handlerResult: true }) as never);
      }),
    ).toThrow("Route 'POST /api/items/:id{");
  });

  it('still accepts plain parameters, wildcards and braces outside a parameter', () => {
    const router = new Router();
    expect(() => {
      router.get('/users/:id', () => ({ __handlerResult: true }) as never);
      router.get('/files/*', () => ({ __handlerResult: true }) as never);
      router.get('/literal{brace}', () => ({ __handlerResult: true }) as never);
    }).not.toThrow();
    expect(router.match('GET', '/users/7')?.params).toEqual({ id: '7' });
  });
});

// Re-audit N2: Hono gives a pattern written without a leading slash one, so
// `admin` and `/admin` are the same route and the second is a duplicate.
describe('patterns written without a leading slash', () => {
  it('match as their slash-prefixed spelling', () => {
    const router = new Router();
    const def = { handler: () => ({ __handlerResult: true }) as never };
    router.get('admin', def);
    expect(router.match('GET', '/admin')?.definition).toBe(def);
  });

  it('collide with the slash-prefixed spelling of the same route', () => {
    const router = new Router();
    router.get('admin', () => ({ __handlerResult: true }) as never);
    expect(() => router.get('/admin', () => ({ __handlerResult: true }) as never)).toThrow(
      "Route 'GET /admin' is already registered",
    );
  });
});

// Security re-audit N4: shapes outside the route grammar routed differently
// under TrieRouter than under LinearRouter, so they are refused at
// registration. The table is the grammar's edge, as data.
describe('patterns outside the route grammar', () => {
  it.each([
    ['/api//:id', 'an empty segment (`//`)'],
    ['/trailing//', 'an empty segment (`//`)'],
    ['/v*/admin', "the wildcard segment 'v*'"],
    ['/a*b', "the wildcard segment 'a*b'"],
    ['/users/:user-id', "the parameter name 'user-id'"],
    ['/x/:__proto__', "the parameter name '__proto__'"],
    ['/u/:id?/', 'an optional parameter that is not the final segment'],
    ['/p/:id?/edit', 'an optional parameter that is not the final segment'],
    ['/search?q', "'?' outside a final optional parameter"],
  ])('refuses %s', (pattern, reason) => {
    const router = new Router();
    expect(() => router.get(pattern, () => ({ __handlerResult: true }) as never)).toThrow(
      `Route 'GET ${pattern}' uses ${reason}`,
    );
    expect(router.getAll()).toEqual([]);
  });

  it.each([
    '/',
    '/users',
    '/users/',
    '/users/:id',
    '/users/:id/',
    '/u/:id?',
    '/files/*',
    '/*',
    '/files*',
    '/:a/*',
    '/_x/:snake_case',
    '/users/:1st',
    '/x/:constructor',
  ])('accepts %s', (pattern) => {
    const router = new Router();
    expect(() => router.get(pattern, () => ({ __handlerResult: true }) as never)).not.toThrow();
  });

  it('optional final parameter answers with and without it', () => {
    const router = new Router();
    router.get('/u/:id?', () => ({ __handlerResult: true }) as never);
    expect(router.match('GET', '/u/7')?.params).toEqual({ id: '7' });
    expect(router.match('GET', '/u')).not.toBe(null);
  });
});

describe('group prefixes join with exactly one slash', () => {
  it.each([
    ['/api/', '/:id', '/api/:id'],
    ['/api', '/:id', '/api/:id'],
    ['/api', ':id', '/api/:id'],
    ['/', '/x', '/x'],
    ['/api', '/', '/api'],
    ['/api/', '/', '/api/'],
  ])('group(%s) + %s registers %s', (prefix, path, expected) => {
    const router = new Router();
    router.group(prefix, (group) => {
      group.get(path, () => ({ __handlerResult: true }) as never);
    });
    expect(router.getAll()[0]!.pattern).toBe(expected);
  });

  it('joins nested group prefixes the same way', () => {
    const router = new Router();
    router.group('/api/', (api) => {
      api.group('/v1/', (v1) => {
        v1.get('/items', () => ({ __handlerResult: true }) as never);
      });
    });
    expect(router.getAll()[0]!.pattern).toBe('/api/v1/items');
    expect(router.match('GET', '/api/v1/items')).not.toBe(null);
  });
});

describe('parameter decoding', () => {
  it('routes a parameter named after an Object.prototype member as develop did', () => {
    const router = new Router();
    router.get('/x/:constructor', () => ({ __handlerResult: true }) as never);
    expect(router.match('GET', '/x/abc')?.params).toEqual({ constructor: 'abc' });
  });

  it('accepts a parameter name starting with a digit, as LinearRouter did', () => {
    const router = new Router();
    router.get('/users/:1st', () => ({ __handlerResult: true }) as never);
    expect(router.match('GET', '/users/a')?.params).toEqual({ '1st': 'a' });
  });
});

// Security re-audit N6: TrieRouter keeps the parameters after a `*` segment on
// a plain object, so a developer's name was read back as an inherited member.
// Parameters reach Hono under the kernel's own names; every Object.prototype
// member name (but `__proto__`, refused at registration) routes in every shape.
describe('parameter names that are Object.prototype members', () => {
  const NAMES = Object.getOwnPropertyNames(Object.prototype).filter((name) => name !== '__proto__');
  const SHAPES: readonly (readonly [
    string,
    (name: string) => string,
    string,
    Record<string, string>,
  ])[] = [
    ['after * (last)', (n) => `/files/*/:${n}`, '/files/a/b', { v: 'b' }],
    ['after a leading *', (n) => `/*/:${n}`, '/a/b', { v: 'b' }],
    ['after * then static', (n) => `/*/:${n}/s`, '/a/b/s', { v: 'b' }],
    ['second after *', (n) => `/*/:a/:${n}`, '/x/y/z', { a: 'y', v: 'z' }],
    ['plain', (n) => `/x/:${n}`, '/x/b', { v: 'b' }],
  ];

  it.each(
    SHAPES.flatMap(([shape, pattern, path, expected]) =>
      NAMES.map((name) => [name, shape, pattern(name), path, expected] as const),
    ),
  )('routes :%s %s', (name, _shape, pattern, path, expected) => {
    const router = new Router();
    router.get(pattern, () => ({ __handlerResult: true }) as never);
    const want = Object.fromEntries(
      Object.entries(expected).map(([key, value]) => [key === 'v' ? name : key, value]),
    );
    expect(router.match('GET', path)?.params).toEqual(want);
  });

  it('keeps the first value when two parameters share a name', () => {
    const router = new Router();
    router.get('/x/:id/:id', () => ({ __handlerResult: true }) as never);
    expect(router.match('GET', '/x/1/2')?.params).toEqual({ id: '1' });
  });

  it('leaves an omitted optional parameter out of params', () => {
    const router = new Router();
    router.get('/u/:id?', () => ({ __handlerResult: true }) as never);
    expect(router.match('GET', '/u')?.params).toEqual({});
  });
});
