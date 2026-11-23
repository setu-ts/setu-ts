import { describe, expect, it } from 'vitest';

import type { InterceptorScope, SwaggerRequest } from '../../src/ui/swagger-interceptor.ts';
import { createCsrfRequestInterceptor } from '../../src/ui/swagger-interceptor.ts';

const PAGE = 'https://api.example/docs';

function scope(response: { status: number; body?: unknown } | Error): {
  scope: InterceptorScope;
  fetched: string[];
} {
  const fetched: string[] = [];
  return {
    fetched,
    scope: {
      location: { href: PAGE, origin: 'https://api.example' },
      fetch: (url) => {
        fetched.push(url);
        if (response instanceof Error) return Promise.reject(response);
        return Promise.resolve({
          status: response.status,
          json: () => Promise.resolve(response.body),
        });
      },
    },
  };
}

const TOKEN = { status: 200, body: { headerName: 'x-form-token', token: 't0k3n' } };

describe('Swagger UI CSRF request interceptor', () => {
  it('sets the served header on a same-origin lowercase post', async () => {
    const { scope: s, fetched } = scope(TOKEN);
    const request: SwaggerRequest = {
      url: '/orders',
      method: 'post',
      headers: { accept: 'application/json' },
    };
    const out = await createCsrfRequestInterceptor('/docs/csrf-token', s)(request);
    expect(fetched).toEqual(['/docs/csrf-token']);
    expect(out.headers).toEqual({ accept: 'application/json', 'x-form-token': 't0k3n' });
  });

  it.each(['get', 'HEAD', 'options', undefined])(
    'leaves a %s request alone with no fetch',
    async (method) => {
      const { scope: s, fetched } = scope(TOKEN);
      const request: SwaggerRequest = {
        url: '/orders',
        ...(method === undefined ? {} : { method }),
      };
      const out = await createCsrfRequestInterceptor('/docs/csrf-token', s)(request);
      expect(fetched).toEqual([]);
      expect(out.headers).toBeUndefined();
    },
  );

  it('concurrent calls share one token fetch, and a later call fetches again', async () => {
    let minted = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s: InterceptorScope = {
      location: { href: PAGE, origin: 'https://api.example' },
      fetch: async () => {
        const token = `t${++minted}`;
        await gate;
        return {
          status: 200,
          json: () => Promise.resolve({ headerName: 'x-form-token', token }),
        };
      },
    };
    const intercept = createCsrfRequestInterceptor('/docs/csrf-token', s);
    const first = intercept({ url: '/orders', method: 'post' });
    const second = intercept({ url: '/orders', method: 'delete' });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(minted).toBe(1);
    expect([a.headers?.['x-form-token'], b.headers?.['x-form-token']]).toEqual(['t1', 't1']);
    const later = await intercept({ url: '/orders', method: 'post' });
    expect(minted).toBe(2);
    expect(later.headers?.['x-form-token']).toBe('t2');
  });

  it('leaves a cross-origin post (an OAuth2 token URL, another server) alone with no fetch', async () => {
    const { scope: s, fetched } = scope(TOKEN);
    for (const url of ['https://idp.example/token', 'http://api.example/orders']) {
      const out = await createCsrfRequestInterceptor(
        '/docs/csrf-token',
        s,
      )({ url, method: 'post' });
      expect(out.headers).toBeUndefined();
    }
    expect(fetched).toEqual([]);
  });

  it('leaves the request unchanged on a 204', async () => {
    const { scope: s, fetched } = scope({ status: 204 });
    const out = await createCsrfRequestInterceptor(
      '/docs/csrf-token',
      s,
    )({
      url: 'https://api.example/orders',
      method: 'delete',
    });
    expect(fetched).toHaveLength(1);
    expect(out.headers).toBeUndefined();
  });

  it('leaves the request unchanged when the fetch fails or the body is not a token', async () => {
    for (const response of [new Error('offline'), { status: 200, body: { token: 1 } }]) {
      const { scope: s } = scope(response);
      const out = await createCsrfRequestInterceptor(
        '/docs/csrf-token',
        s,
      )({
        url: '/orders',
        method: 'put',
      });
      expect(out.headers).toBeUndefined();
    }
  });
});
