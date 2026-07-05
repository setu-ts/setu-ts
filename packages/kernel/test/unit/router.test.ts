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
});
