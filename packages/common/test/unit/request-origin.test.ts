import { describe, it, expect } from 'vitest';
import { requestOriginOf, publicRequestUrl, REQUEST_ORIGIN_STATE_KEY } from '../../src/index.ts';
import type { IRequestContext, RequestOrigin } from '../../src/index.ts';

function context(url: string): IRequestContext {
  return { request: { url }, state: new Map() } as unknown as IRequestContext;
}

describe('request origin accessors', () => {
  it('derives http and https origins without believing headers', () => {
    for (const protocol of ['http', 'https']) {
      const ctx = context(`${protocol}://internal:8080/a?q=1`);
      expect(requestOriginOf(ctx)).toEqual({
        protocol,
        host: 'internal:8080',
        origin: `${protocol}://internal:8080`,
      });
      expect(publicRequestUrl(ctx)).toBe(ctx.request.url);
    }
  });
  it('uses the published value and preserves path, query and fragment', () => {
    const ctx = context('http://internal/a%2Fb?q=1#section');
    ctx.state.set(REQUEST_ORIGIN_STATE_KEY, { protocol: 'https', host: 'public.example:8443' });
    const origin: RequestOrigin = requestOriginOf(ctx);
    expect(origin).toEqual({
      protocol: 'https',
      host: 'public.example:8443',
      origin: 'https://public.example:8443',
    });
    expect(publicRequestUrl(ctx)).toBe('https://public.example:8443/a%2Fb?q=1#section');
  });
  it('preserves the original URL byte for byte with no publication', () => {
    const ctx = context('http://LOCALHOST:80/a?x=%2f');
    expect(publicRequestUrl(ctx)).toBe(ctx.request.url);
  });
});
