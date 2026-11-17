/**
 * Derived error responses (M137b §3.2–§3.6, §3.9): the shared table run
 * against the generator, plus the generator-only rules — the option, the
 * `WWW-Authenticate` scheme condition, declared statuses and headers winning,
 * and response ordering.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import type { MiddlewareFunction, RouteInfo } from '@setu-ts/common';
import { withRateLimitMetadata, withSecurityMetadata } from '@setu-ts/common';
import { requireAuth, requireScopes } from '@setu-ts/auth-plugin';
import { idempotent } from '@setu-ts/idempotency-plugin';

import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';
import type {
  OpenApiGeneratorOptions,
  OpenApiOperation,
} from '../../src/generators/openapi-generator.ts';
import { BEARER_SCHEMES, ERROR_RESPONSE_TABLE } from '../fixtures/error-response-table.ts';

function route(
  method: RouteInfo['method'],
  path: string,
  middleware: MiddlewareFunction[],
  schema?: RouteInfo['definition']['schema'],
): RouteInfo {
  return {
    method,
    path,
    definition: {
      handler: () => {
        throw new Error('not used');
      },
      middleware,
      ...(schema !== undefined ? { schema } : {}),
    },
  };
}

const bearer: Partial<OpenApiGeneratorOptions> = {
  securitySchemes: BEARER_SCHEMES,
  deriveSecurity: { scheme: 'bearerAuth' },
};

function operation(
  r: RouteInfo,
  options: Partial<OpenApiGeneratorOptions> = bearer,
): OpenApiOperation {
  const doc = new OpenApiGenerator({ title: 'T', version: '1', ...options }).generate([r]);
  const ops = doc.paths[r.path.replace(/:(\w+)/g, '{$1}')] as Record<string, OpenApiOperation>;
  return ops[r.method.toLowerCase()] as OpenApiOperation;
}

/** Error statuses (non-2xx) → their header names. */
function errorHeaders(op: OpenApiOperation): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [status, response] of Object.entries(op.responses)) {
    if (/^2/.test(status)) continue;
    out[status] = Object.keys(response.headers ?? {});
  }
  return out;
}

describe('the M137b table against the generator', () => {
  for (const row of ERROR_RESPONSE_TABLE) {
    it(row.name, () => {
      const op = operation(route(row.method, '/r', row.middleware()));
      expect(errorHeaders(op)).toEqual(row.errors);
      expect(Object.keys(op.responses['200']?.headers ?? {})).toEqual(row.successHeaders);
      for (const header of Object.values(op.responses['200']?.headers ?? {})) {
        expect(header.schema).toBeDefined();
        expect(typeof header.description).toBe('string');
      }
    });
  }
});

describe('deriveErrorResponses', () => {
  it('emits none of the derived statuses or headers when false', () => {
    const op = operation(route('POST', '/r', [requireScopes('a'), idempotent()]), {
      ...bearer,
      deriveErrorResponses: false,
    });
    expect(Object.keys(op.responses)).toEqual(['200']);
    expect(op.responses['200']?.headers).toBeUndefined();
    // The key parameter is request shape and stays (PR #561).
    expect(op.parameters?.some((p) => p.name === 'Idempotency-Key')).toBe(true);
  });

  it('is on by default', () => {
    const op = operation(route('GET', '/r', [requireAuth()]), {});
    expect(Object.keys(op.responses)).toEqual(['200', '401']);
  });

  it('never documents 403 for requireAuth() alone', () => {
    expect(operation(route('GET', '/r', [requireAuth()])).responses['403']).toBeUndefined();
  });
});

describe('the WWW-Authenticate scheme condition', () => {
  const cases: readonly {
    readonly name: string;
    readonly options: Partial<OpenApiGeneratorOptions>;
    readonly challenge: boolean;
  }[] = [
    { name: 'no deriveSecurity', options: { securitySchemes: BEARER_SCHEMES }, challenge: false },
    { name: 'http bearer', options: bearer, challenge: true },
    {
      name: 'http Bearer in another case',
      options: {
        securitySchemes: { s: { type: 'http', scheme: 'Bearer' } },
        deriveSecurity: { scheme: 's' },
      },
      challenge: true,
    },
    {
      name: 'http basic',
      options: {
        securitySchemes: { s: { type: 'http', scheme: 'basic' } },
        deriveSecurity: { scheme: 's' },
      },
      challenge: false,
    },
    {
      name: 'oauth2',
      options: { securitySchemes: { s: { type: 'oauth2' } }, deriveSecurity: { scheme: 's' } },
      challenge: true,
    },
    {
      name: 'openIdConnect',
      options: {
        securitySchemes: { s: { type: 'openIdConnect' } },
        deriveSecurity: { scheme: 's' },
      },
      challenge: true,
    },
    {
      name: 'a session cookie (apiKey in cookie)',
      options: {
        securitySchemes: { s: { type: 'apiKey', in: 'cookie', name: 'sid' } },
        deriveSecurity: { scheme: 's' },
      },
      challenge: false,
    },
    {
      name: 'a scheme the document does not declare',
      options: { deriveSecurity: { scheme: 'missing' } },
      challenge: false,
    },
    {
      name: 'a non-object scheme value',
      options: { securitySchemes: { s: 'bearer' }, deriveSecurity: { scheme: 's' } },
      challenge: false,
    },
  ];
  for (const { name, options, challenge } of cases) {
    it(`${challenge ? 'lists' : 'omits'} it for ${name}`, () => {
      const op = operation(route('GET', '/r', [requireScopes('a')]), options);
      const expected = challenge ? ['WWW-Authenticate'] : [];
      expect(Object.keys(op.responses['401']?.headers ?? {})).toEqual(expected);
      expect(Object.keys(op.responses['403']?.headers ?? {})).toEqual(expected);
    });
  }

  it('omits it on a 403 whose guard records no scopes', () => {
    const forbidding = withSecurityMetadata(() => Promise.resolve(), {
      authenticated: true,
      forbids: true,
      scopes: [],
    });
    const op = operation(route('GET', '/r', [forbidding]));
    expect(op.responses['403']?.headers).toBeUndefined();
    expect(Object.keys(op.responses['401']?.headers ?? {})).toEqual(['WWW-Authenticate']);
  });

  it('documents 401 for an anonymous-allowed guard that can still forbid', () => {
    const anonymousPolicy = withSecurityMetadata(() => Promise.resolve(), {
      authenticated: false,
      forbids: true,
    });
    const op = operation(route('GET', '/r', [anonymousPolicy]));
    expect(Object.keys(op.responses)).toEqual(['200', '401', '403']);
  });
});

describe('declared responses win', () => {
  it('leaves a declared error status and its content untouched', () => {
    const declared = { description: 'Custom unauthorized', schema: z.object({ code: z.string() }) };
    const op = operation(
      route('GET', '/r', [requireScopes('a')], { response: { 401: declared } }),
      {
        ...bearer,
        errorSchema: 'rfc9457',
      },
    );
    expect(op.responses['401']?.description).toBe('Custom unauthorized');
    expect(op.responses['401']?.headers).toBeUndefined();
    expect(op.responses['401']?.content?.['application/problem+json']).toBeUndefined();
    expect(op.responses['401']?.content?.['application/json']).toBeDefined();
    // The undeclared 403 is still derived.
    expect(op.responses['403']?.content?.['application/problem+json']).toBeDefined();
  });

  it('keeps a declared success header over a derived one of the same name, any case', () => {
    const limiter = withRateLimitMetadata(() => Promise.resolve(), { standardHeaders: true });
    const op = operation(
      route('GET', '/r', [limiter], {
        response: {
          200: {
            description: 'OK',
            headers: { ratelimit: { description: 'Declared', required: true } },
          },
        },
      }),
    );
    const headers = op.responses['200']?.headers ?? {};
    expect(Object.keys(headers)).toEqual(['ratelimit', 'RateLimit-Policy']);
    expect(headers['ratelimit']).toEqual({
      description: 'Declared',
      required: true,
      schema: { type: 'string' },
    });
  });

  it('adds derived success headers to a re-keyed success status', () => {
    const limiter = withRateLimitMetadata(() => Promise.resolve(), { standardHeaders: true });
    const r = route('POST', '/r', [limiter], { response: { 201: z.object({ id: z.string() }) } });
    const op = operation(r);
    expect(Object.keys(op.responses['201']?.headers ?? {})).toEqual([
      'RateLimit',
      'RateLimit-Policy',
    ]);
    expect(Object.keys(op.responses['201'] ?? {})).toEqual(['description', 'headers', 'content']);
  });

  it('merges a second limiter: either writing the standard fields documents them', () => {
    const plain = withRateLimitMetadata(() => Promise.resolve(), { standardHeaders: false });
    const standard = withRateLimitMetadata(() => Promise.resolve(), { standardHeaders: true });
    const op = operation(route('GET', '/r', [plain, standard]));
    expect(Object.keys(op.responses['429']?.headers ?? {})).toEqual([
      'RateLimit',
      'RateLimit-Policy',
      'Retry-After',
    ]);
  });

  it('merges idempotency and a limiter into one 429 carrying the limiter headers', () => {
    const limiter = withRateLimitMetadata(() => Promise.resolve(), { standardHeaders: false });
    const op = operation(route('POST', '/r', [limiter, idempotent()]));
    expect(Object.keys(op.responses['429']?.headers ?? {})).toEqual(['Retry-After']);
    expect(Object.keys(op.responses['200']?.headers ?? {})).toEqual(['Idempotent-Replayed']);
  });
});

describe('response ordering (§3.9)', () => {
  it('orders statuses ascending whatever the middleware and declaration order', () => {
    const op = operation(
      route('POST', '/r', [idempotent(), requireScopes('a')], {
        response: { 404: z.object({}), 201: z.object({}) },
      }),
    );
    expect(Object.keys(op.responses)).toEqual([
      '201',
      '400',
      '401',
      '403',
      '404',
      '409',
      '422',
      '429',
    ]);
  });

  it('keeps a route with no brands exactly as before', () => {
    const op = operation(route('GET', '/r', []));
    expect(op.responses).toEqual({ '200': { description: 'Successful response' } });
  });
});
