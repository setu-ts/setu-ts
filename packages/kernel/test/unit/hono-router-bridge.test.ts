/**
 * Tests that exercise the REAL `@hono/hono` import inside the Router.
 *
 * These tests assert the `Router` → Hono → `{ definition, params }` mapping
 * directly: identity of returned definition, param extraction, static-over-param
 * preference, no-match → null, and the §3.6 tie-break.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Router } from '../../src/router/router.ts';

describe('Hono router bridge — definition identity', () => {
  it('match() returns the SAME definition object the caller registered', () => {
    const router = new Router();
    const handler = () => ({ __handlerResult: true } as never);
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
    router.get('/users/:id', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/users/123');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({ id: '123' });
  });

  it('extracts multiple params: /users/:userId/posts/:postId', () => {
    const router = new Router();
    router.get('/users/:userId/posts/:postId', () => ({
      __handlerResult: true,
    } as never));
    const result = router.match('GET', '/users/123/posts/456');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({ userId: '123', postId: '456' });
  });

  it('extracts string params (not coerced to numbers)', () => {
    const router = new Router();
    router.get('/items/:id', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/items/99');
    expect(result).not.toBe(null);
    expect(typeof result!.params.id).toBe('string');
    expect(result!.params.id).toBe('99');
  });
});

describe('Hono router bridge — static-over-param', () => {
  it('prefers static /users/me over param /users/:id', () => {
    const router = new Router();
    router.get('/users/:id', () => ({ __handlerResult: true } as never));
    router.get('/users/me', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/users/me');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({});
  });
});

describe('Hono router bridge — no match returns null', () => {
  it('returns null when no route matches the path', () => {
    const router = new Router();
    router.get('/users', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/posts');
    expect(result).toBe(null);
  });

  it('returns null when method does not match', () => {
    const router = new Router();
    router.get('/users', () => ({ __handlerResult: true } as never));
    const result = router.match('POST', '/users');
    expect(result).toBe(null);
  });
});

describe('Hono router bridge — §3.6 tie-break deterministic', () => {
  it('breaks ties by earliest registration order', () => {
    const router = new Router();
    const defX = { handler: () => ({ __handlerResult: true } as never) };
    const defY = { handler: () => ({ __handlerResult: true } as never) };
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
    router.get('/users', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/users/');
    expect(result).not.toBe(null);
  });

  it('/users/123/ matches /users/:id route (strict: false)', () => {
    const router = new Router();
    router.get('/users/:id', () => ({ __handlerResult: true } as never));
    const result = router.match('GET', '/users/123/');
    expect(result).not.toBe(null);
    expect(result!.params).toEqual({ id: '123' });
  });
});
