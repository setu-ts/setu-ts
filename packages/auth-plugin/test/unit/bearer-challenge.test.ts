/**
 * The single Bearer challenge writer: formatter table and middleware branches.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type { HandlerResult, IRequest, IRequestContext, IResponse } from '@setu-ts/common';
import { authorizationFailureInit, withHttpStatusHint } from '@setu-ts/common';
import {
  bearerChallenge,
  formatBearerChallenge,
  REQUIRED_SCOPES_STATE_KEY,
} from '../../src/resource-server/challenge.ts';

/** A response whose status and headers are live, as the kernel's builder is. */
function createContext(options: {
  authorization?: string;
  status?: number;
  state?: Map<string, unknown>;
}): { ctx: IRequestContext; headers: Headers; state: Map<string, unknown> } {
  let statusCode = options.status ?? 200;
  const headers = new Headers();
  const response: IResponse = {
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    setHeaders: () => response,
    header: (name: string, value: string) => {
      headers.set(name, value);
      return response;
    },
    appendHeader: (name: string, value: string) => {
      headers.append(name, value);
      return response;
    },
    json: <T>(_body: T): HandlerResult => ({ __handlerResult: true }),
    text: (_body: string): HandlerResult => ({ __handlerResult: true }),
    html: (_body: string): HandlerResult => ({ __handlerResult: true }),
    send: (_body?: Uint8Array): HandlerResult => ({ __handlerResult: true }),
    redirect: (): HandlerResult => ({ __handlerResult: true }),
    stream: (): HandlerResult => ({ __handlerResult: true }),
    snapshot: () => ({ streaming: false, status: statusCode, headers, body: null }),
  };
  const requestHeaders = new Headers();
  if (options.authorization !== undefined) {
    requestHeaders.set('authorization', options.authorization);
  }
  const request = {
    method: 'GET',
    url: '/',
    path: '/',
    headers: requestHeaders,
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as unknown as IRequest;
  const state = options.state ?? new Map<string, unknown>();
  return {
    ctx: {
      id: 'test',
      request,
      response,
      services: {} as unknown as IRequestContext['services'],
      params: {},
      query: {},
      state,
      startTime: 0,
      signal: new AbortController().signal,
    },
    headers,
    state,
  };
}

/** Runs the middleware with a downstream that sets `status`. */
async function run(
  ctx: IRequestContext,
  status: number,
  deps: Parameters<typeof bearerChallenge>[0] = {},
): Promise<void> {
  const next = (): Promise<void> => {
    ctx.response.status(status);
    return Promise.resolve();
  };
  await bearerChallenge(deps)(ctx, next);
}

describe('formatBearerChallenge', () => {
  const cases: Array<[string, Parameters<typeof formatBearerChallenge>[0], string]> = [
    ['bare', {}, 'Bearer'],
    ['invalid token', { error: 'invalid_token' }, 'Bearer error="invalid_token"'],
    [
      'insufficient scope lists the required scopes',
      { error: 'insufficient_scope', scopes: ['tools:read', 'tools:list'] },
      'Bearer error="insufficient_scope", scope="tools:read tools:list"',
    ],
    [
      'resource metadata',
      { resourceMetadata: 'https://h/.well-known/oauth-protected-resource' },
      'Bearer resource_metadata="https://h/.well-known/oauth-protected-resource"',
    ],
    [
      'all parameters in a fixed order',
      {
        error: 'insufficient_scope',
        scopes: ['b', 'a'],
        resourceMetadata: 'https://h/meta',
      },
      'Bearer error="insufficient_scope", scope="b a", resource_metadata="https://h/meta"',
    ],
    ['empty scopes are omitted', { scopes: [] }, 'Bearer'],
    [
      'quoted values are escaped',
      { resourceMetadata: 'https://h/a"b\\c' },
      'Bearer resource_metadata="https://h/a\\"b\\\\c"',
    ],
  ];

  it.each(cases)('%s', (_label, options, expected) => {
    expect(formatBearerChallenge(options)).toBe(expected);
  });
});

describe('bearer-challenge middleware', () => {
  it('adds a bare challenge to a 401 without credentials', async () => {
    const { ctx, headers } = createContext({});
    await run(ctx, 401);
    expect(headers.get('www-authenticate')).toBe('Bearer');
  });

  it('adds invalid_token to a 401 that carried a Bearer header', async () => {
    const { ctx, headers } = createContext({ authorization: 'Bearer a-token' });
    await run(ctx, 401);
    expect(headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  it('matches the Bearer scheme case-insensitively and never echoes the token', async () => {
    const { ctx, headers } = createContext({ authorization: 'bEaReR "><script>' });
    await run(ctx, 401);
    expect(headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(headers.get('www-authenticate')).not.toContain('script');
  });

  it('leaves a non-Bearer 401 bare', async () => {
    const { ctx, headers } = createContext({ authorization: 'Basic dXNlcjpwYXNz' });
    await run(ctx, 401);
    expect(headers.get('www-authenticate')).toBe('Bearer');
  });

  it('adds insufficient_scope and only the route-required scopes on a scope 403', async () => {
    const state = new Map<string, unknown>([
      [REQUIRED_SCOPES_STATE_KEY, ['tools:read', 'tools:list']],
    ]);
    const { ctx, headers } = createContext({ state });
    await run(ctx, 403);
    expect(headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="tools:read tools:list"',
    );
  });

  it('leaves a 403 without a required-scope state entry alone', async () => {
    const { ctx, headers } = createContext({});
    await run(ctx, 403);
    expect(headers.has('www-authenticate')).toBe(false);
  });

  it('ignores a malformed or empty required-scope state entry', async () => {
    for (const value of [[], ['read', 7], ['bad scope'], 'read', null]) {
      const state = new Map<string, unknown>([[REQUIRED_SCOPES_STATE_KEY, value]]);
      const { ctx, headers } = createContext({ state });
      await run(ctx, 403);
      expect(headers.has('www-authenticate')).toBe(false);
    }
  });

  it('leaves a redirect untouched', async () => {
    const { ctx, headers } = createContext({});
    await run(ctx, 302);
    expect(headers.has('www-authenticate')).toBe(false);
  });

  it('never overwrites a header the application already set', async () => {
    const { ctx, headers } = createContext({});
    const next = (): Promise<void> => {
      ctx.response.header('WWW-Authenticate', 'Custom realm="app"');
      ctx.response.status(401);
      return Promise.resolve();
    };
    await bearerChallenge()(ctx, next);
    expect(headers.get('www-authenticate')).toBe('Custom realm="app"');
  });

  it('adds the configured resource_metadata to both challenge forms', async () => {
    const deps = { resourceMetadata: 'https://h/.well-known/oauth-protected-resource/mcp' };
    const unauthorized = createContext({ authorization: 'Bearer x' });
    await run(unauthorized.ctx, 401, deps);
    expect(unauthorized.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", ' +
        'resource_metadata="https://h/.well-known/oauth-protected-resource/mcp"',
    );

    const forbidden = createContext({
      state: new Map<string, unknown>([[REQUIRED_SCOPES_STATE_KEY, ['read']]]),
    });
    await run(forbidden.ctx, 403, deps);
    expect(forbidden.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="read", ' +
        'resource_metadata="https://h/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('adds a challenge to a thrown 401 hint and rethrows it', async () => {
    const { ctx, headers } = createContext({ authorization: 'Bearer x' });
    const error = withHttpStatusHint(
      new Error('denied'),
      authorizationFailureInit('authentication-required'),
    );
    const next = (): Promise<void> => {
      throw error;
    };
    await expect(bearerChallenge()(ctx, next)).rejects.toBe(error);
    expect(headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  it('rethrows a non-401 error without a challenge', async () => {
    const { ctx, headers } = createContext({});
    const error = withHttpStatusHint(
      new Error('denied'),
      authorizationFailureInit('insufficient-privileges'),
    );
    const next = (): Promise<void> => {
      throw error;
    };
    await expect(bearerChallenge()(ctx, next)).rejects.toBe(error);
    expect(headers.has('www-authenticate')).toBe(false);

    const plain = createContext({});
    await expect(
      bearerChallenge()(plain.ctx, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(plain.headers.has('www-authenticate')).toBe(false);
  });
});
