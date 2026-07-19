import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Router } from '../../src/router/router.ts';

describe('Router', () => {
  it('should register and match GET route', () => {
    const router = new Router();
    router.get('/users', { handler: () => ({ __handlerResult: true } as never) });
    const result = router.match('GET', '/users');
    expect(result).not.toBe(null);
  });

  it('should extract params from matched route', () => {
    const router = new Router();
    router.get('/users/:id', { handler: () => ({ __handlerResult: true } as never) });
    const result = router.match('GET', '/users/123');
    expect(result?.params).toEqual({ id: '123' });
  });

  it('should return null for unmatched route', () => {
    const router = new Router();
    router.get('/users', { handler: () => ({ __handlerResult: true } as never) });
    const result = router.match('GET', '/posts');
    expect(result).toBe(null);
  });

  it('should return null for wrong method', () => {
    const router = new Router();
    router.get('/users', { handler: () => ({ __handlerResult: true } as never) });
    const result = router.match('POST', '/users');
    expect(result).toBe(null);
  });

  it('should support all 7 verbs', () => {
    const router = new Router();
    router.get('/g', { handler: () => ({ __handlerResult: true } as never) });
    router.post('/p', { handler: () => ({ __handlerResult: true } as never) });
    router.put('/pu', { handler: () => ({ __handlerResult: true } as never) });
    router.patch('/pa', { handler: () => ({ __handlerResult: true } as never) });
    router.delete('/d', { handler: () => ({ __handlerResult: true } as never) });
    router.head('/h', { handler: () => ({ __handlerResult: true } as never) });
    router.options('/o', { handler: () => ({ __handlerResult: true } as never) });

    expect(router.match('GET', '/g')).not.toBe(null);
    expect(router.match('POST', '/p')).not.toBe(null);
    expect(router.match('PUT', '/pu')).not.toBe(null);
    expect(router.match('PATCH', '/pa')).not.toBe(null);
    expect(router.match('DELETE', '/d')).not.toBe(null);
    expect(router.match('HEAD', '/h')).not.toBe(null);
    expect(router.match('OPTIONS', '/o')).not.toBe(null);
  });

  it('should prefer static segments over params', () => {
    const router = new Router();
    router.get('/users/:id', { handler: () => ({ __handlerResult: true } as never) });
    router.get('/users/me', { handler: () => ({ __handlerResult: true } as never) });

    const result = router.match('GET', '/users/me');
    expect(result?.params).toEqual({});
  });

  it('should break ties with earliest registration', () => {
    const router = new Router();
    router.get('/a/:x', { handler: () => ({ __handlerResult: true } as never) });
    router.get('/a/:y', { handler: () => ({ __handlerResult: true } as never) });

    const result = router.match('GET', '/a/123');
    expect(result?.params).toEqual({ x: '123' });
  });

  it('should support groups with prefix', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.get('/users', { handler: () => ({ __handlerResult: true } as never) });
    });

    const result = router.match('GET', '/api/users');
    expect(result).not.toBe(null);
  });

  it('should support nested groups', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.group('/v1', (r2) => {
        r2.get('/users', { handler: () => ({ __handlerResult: true } as never) });
      });
    });

    const result = router.match('GET', '/api/v1/users');
    expect(result).not.toBe(null);
  });

  it('should accept bare handler', () => {
    const router = new Router();
    router.get('/bare', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/bare');
    expect(result).not.toBe(null);
    expect(result?.definition.middleware).toBe(undefined);
  });

  it('should accept route definition with middleware', () => {
    const router = new Router();
    const mw = [() => {}];
    router.get('/with-mw', {
      handler: () => ({ __handlerResult: true } as never),
      middleware: mw,
    });
    const result = router.match('GET', '/with-mw');
    expect(result?.definition.middleware).toBe(mw);
  });

  it('should expose getAll for introspection', () => {
    const router = new Router();
    router.get('/a', () => ({ __handlerResult: true } as never));
    router.post('/b', () => ({ __handlerResult: true } as never));
    const all = router.getAll();
    expect(all.length).toBe(2);
    expect(all[0].method).toBe('GET');
    expect(all[1].method).toBe('POST');
  });

  it('should handle group with root path inside', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.get('/', () => ({ __handlerResult: true } as never));
    });
    const result = router.match('GET', '/api');
    expect(result).not.toBe(null);
  });

  it('should handle nested group with root path', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.group('/v1', (r2) => {
        r2.get('/', () => ({ __handlerResult: true } as never));
      });
    });
    const result = router.match('GET', '/api/v1');
    expect(result).not.toBe(null);
  });

  it('should match route with multiple params', () => {
    const router = new Router();
    router.get('/users/:userId/posts/:postId', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/users/123/posts/456');
    expect(result?.params).toEqual({ userId: '123', postId: '456' });
  });

  it('should prefer route with more static segments', () => {
    const router = new Router();
    router.get('/:a/:b/:c', () => ({ __handlerResult: true } as never));
    router.get('/users/:id/profile', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/users/123/profile');
    expect(result?.params).toEqual({ id: '123' });
  });

  it('GroupRouter: every verb routes through the prefix', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.put('/p', () => ({ __handlerResult: true } as never));
      r.patch('/pa', () => ({ __handlerResult: true } as never));
      r.delete('/d', () => ({ __handlerResult: true } as never));
      r.head('/h', () => ({ __handlerResult: true } as never));
      r.options('/o', () => ({ __handlerResult: true } as never));
    });
    expect(router.match('PUT', '/api/p')).not.toBe(null);
    expect(router.match('PATCH', '/api/pa')).not.toBe(null);
    expect(router.match('DELETE', '/api/d')).not.toBe(null);
    expect(router.match('HEAD', '/api/h')).not.toBe(null);
    expect(router.match('OPTIONS', '/api/o')).not.toBe(null);
  });

  it('GroupRouter: nested groups compose prefixes for every verb', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.group('/v1', (r2) => {
        r2.get('/g', () => ({ __handlerResult: true } as never));
        r2.post('/p', () => ({ __handlerResult: true } as never));
        r2.put('/pu', () => ({ __handlerResult: true } as never));
        r2.patch('/pa', () => ({ __handlerResult: true } as never));
        r2.delete('/d', () => ({ __handlerResult: true } as never));
        r2.head('/h', () => ({ __handlerResult: true } as never));
        r2.options('/o', () => ({ __handlerResult: true } as never));
      });
    });
    expect(router.match('GET', '/api/v1/g')).not.toBe(null);
    expect(router.match('POST', '/api/v1/p')).not.toBe(null);
    expect(router.match('PUT', '/api/v1/pu')).not.toBe(null);
    expect(router.match('PATCH', '/api/v1/pa')).not.toBe(null);
    expect(router.match('DELETE', '/api/v1/d')).not.toBe(null);
    expect(router.match('HEAD', '/api/v1/h')).not.toBe(null);
    expect(router.match('OPTIONS', '/api/v1/o')).not.toBe(null);
  });

  it('GroupRouter: group with "/" path resolves to the bare prefix', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.get('/', () => ({ __handlerResult: true } as never));
    });
    expect(router.match('GET', '/api')).not.toBe(null);
  });

  it('getAll returns every registered route with method and pattern', () => {
    const router = new Router();
    router.get('/a', () => ({ __handlerResult: true } as never));
    router.group('/api', (r) => {
      r.post('/b', () => ({ __handlerResult: true } as never));
      r.put('/c', () => ({ __handlerResult: true } as never));
    });
    const all = router.getAll();
    expect(all.length).toBe(3);
    expect(all.map((e) => `${e.method} ${e.pattern}`).sort()).toEqual([
      'GET /a',
      'POST /api/b',
      'PUT /api/c',
    ]);
  });

  // M22 new cases — listRoutes() registration order with composed group paths
  it('listRoutes() returns routes in registration order with composed group paths', () => {
    const router = new Router();
    router.get('/first', () => ({ __handlerResult: true } as never));
    router.group('/api', (r) => {
      r.get('/users', () => ({ __handlerResult: true } as never));
      r.post('/users', () => ({ __handlerResult: true } as never));
    });
    const routes = router.listRoutes();
    expect(routes.length).toBe(3);
    expect(routes[0].path).toBe('/first');
    expect(routes[1].path).toBe('/api/users');
    expect(routes[2].path).toBe('/api/users');
    expect(routes[2].method).toBe('POST');
  });

  // M22 new cases — route registered after a group still in getAll
  it('route registered after a group still appears in getAll', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.get('/users', () => ({ __handlerResult: true } as never));
    });
    router.get('/after-group', () => ({ __handlerResult: true } as never));
    const all = router.getAll();
    expect(all.length).toBe(2);
    expect(all[1].pattern).toBe('/after-group');
  });

  // M22 coverage — parsePattern edge cases
  it('parsePattern handles bare "/" pattern', () => {
    const router = new Router();
    router.get('/', () => ({ __handlerResult: true } as never));
    const all = router.getAll();
    expect(all.length).toBe(1);
    expect(all[0].pattern).toBe('/');
    expect(all[0].statics).toBe(1);
  });

  // M22 coverage — parsePattern edge cases (N1: test name corrected to match actual behavior)
  it('RouteEntry.pattern stores the raw path (trailing slashes preserved)', () => {
    const router = new Router();
    router.get('/trailing//', () => ({ __handlerResult: true } as never));
    const all = router.getAll();
    expect(all.length).toBe(1);
    // pattern stores the raw path; parsePattern strips trailing slashes only for segment counting
    expect(all[0].pattern).toBe('/trailing//');
  });

  // M22 coverage — GroupRouter.group() and listRoutes()
  it('GroupRouter.group() composes prefixes for nested groups', () => {
    const router = new Router();
    router.group('/api', (r) => {
      r.group('/v1', (inner) => {
        inner.get('/resource', () => ({ __handlerResult: true } as never));
      });
    });
    const result = router.match('GET', '/api/v1/resource');
    expect(result).not.toBe(null);
  });

  it('GroupRouter.listRoutes() delegates to parent', () => {
    const router = new Router();
    router.get('/standalone', () => ({ __handlerResult: true } as never));
    router.group('/api', (r) => {
      r.get('/items', () => ({ __handlerResult: true } as never));
    });
    const routes = router.listRoutes();
    expect(routes.length).toBe(2);
  });

  // M22 parity — Hono's low-level router.match() returns raw param values;
  // match() must decode them (the pre-M22 matcher decoded per segment).
  it('decodes percent-encoded param values (parity with pre-M22 matcher)', () => {
    const router = new Router();
    router.get('/users/:id', () => ({ __handlerResult: true } as never));
    expect(router.match('GET', '/users/a%20b')?.params).toEqual({ id: 'a b' });
    expect(router.match('GET', '/users/jos%C3%A9')?.params).toEqual({ id: 'josé' });
  });

  // M22 coverage — a malformed param escape drops the candidate → null
  // (the application 400s these upstream via isPathDecodable; this guards
  // direct callers of match()).
  it('match returns null when a param value is a malformed percent-escape', () => {
    const router = new Router();
    router.get('/users/:id', () => ({ __handlerResult: true } as never));
    expect(router.match('GET', '/users/%zz')).toBe(null);
  });

  // M22 coverage — tie-break: multiple candidates, statics differ
  it('tie-break: more static segments wins', () => {
    const router = new Router();
    router.get('/a/b/c', () => ({ __handlerResult: true } as never));
    router.get('/a/:x/:y', () => ({ __handlerResult: true } as never));
    // Matching /a/b/c triggers tie-break: both routes match, /a/b/c has 3 statics, /a/:x/:y has 0
    const result = router.match('GET', '/a/b/c');
    expect(result).not.toBe(null);
    expect(result?.params).toEqual({});
  });

  // M22 coverage — tie-break: same statics, earliest registration wins
  it('tie-break: same statics → earliest registration wins', () => {
    const router = new Router();
    router.get('/a/:x', () => ({ __handlerResult: true } as never));
    router.get('/a/:y', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/a/123');
    expect(result).not.toBe(null);
    expect(result?.params).toEqual({ x: '123' });
  });

  // M22 coverage — statics counting for param segments
  it('staticSegmentCount returns 0 for all-param pattern', () => {
    const router = new Router();
    router.get('/:a/:b/:c', () => ({ __handlerResult: true } as never));
    const all = router.getAll();
    expect(all[0].statics).toBe(0);
  });

  // M22 coverage — GroupRouter.resolvePath with '/'
  it('GroupRouter resolves "/" path inside group to bare prefix', () => {
    const router = new Router();
    router.group('/prefix', (r) => {
      r.get('/', () => ({ __handlerResult: true } as never));
    });
    const result = router.match('GET', '/prefix');
    expect(result).not.toBe(null);
  });

  // M22 coverage — match with no candidates at all
  it('match returns null when router has no routes', () => {
    const router = new Router();
    const result = router.match('GET', '/anything');
    expect(result).toBe(null);
  });
});
