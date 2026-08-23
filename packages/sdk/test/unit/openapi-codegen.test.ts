import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { generateOpenApiClient, sanitizeIdentifier } from '../../src/codegen/openapi-codegen.ts';
import { OpenApiCodegenError } from '../../src/errors.ts';
import { paramsDocument } from '../fixtures/params-document.ts';
import { usersDocument } from '../fixtures/users-document.ts';
import { inlineShapesDocument } from '../fixtures/inline-shapes-document.ts';
import type {
  SdkOpenApiDocument,
  SdkOpenApiOperation,
  SdkOpenApiParameter,
  SdkOpenApiRequestBody,
  SdkOpenApiSchema,
} from '../../src/codegen/openapi-types.ts';

function makeDoc(
  paths: SdkOpenApiDocument['paths'],
  schemas?: Record<string, SdkOpenApiSchema>,
): SdkOpenApiDocument {
  const base: SdkOpenApiDocument = { openapi: '3.1.0', paths };
  if (schemas) {
    return { ...base, components: { schemas } };
  }
  return base;
}

function makeOp(
  id: string,
  overrides?: Partial<SdkOpenApiOperation>,
): SdkOpenApiOperation {
  return {
    operationId: id,
    responses: {
      '200': {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object' },
          },
        },
      },
    },
    ...overrides,
  };
}

function makeParam(
  name: string,
  loc: SdkOpenApiParameter['in'],
): SdkOpenApiParameter {
  return { name, in: loc, required: true, schema: { type: 'string' } };
}

function makeBody(schema: SdkOpenApiSchema): SdkOpenApiRequestBody {
  return { content: { 'application/json': { schema } }, required: true };
}

function genDoc(schema: SdkOpenApiSchema): SdkOpenApiDocument {
  return makeDoc({
    '/x': {
      get: makeOp('x', {
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema } },
          },
        },
      }),
    },
  });
}

describe('sanitizeIdentifier', () => {
  it('lower-camel-joins parts split on non-alphanumeric runs', () => {
    expect(sanitizeIdentifier('get-user-by-id')).toBe('getUserById');
  });

  it('handles braces from path params', () => {
    expect(sanitizeIdentifier('get-users-{id}')).toBe('getUsersId');
  });

  it('prefixes reserved words', () => {
    expect(sanitizeIdentifier('class')).toBe('_class');
    expect(sanitizeIdentifier('for')).toBe('_for');
  });

  it('prefixes leading digit run with n', () => {
    expect(sanitizeIdentifier('123abc')).toBe('n123abc');
  });

  it('falls back to operation when nothing survives', () => {
    expect(sanitizeIdentifier('---')).toBe('operation');
  });

  it('strips JSON pointer prefix for refs', () => {
    expect(sanitizeIdentifier('#/components/schemas/MyUser')).toBe('myUser');
  });
});

describe('renderSchema via generated output', () => {
  it('maps string type', () => {
    const schema: SdkOpenApiSchema = { type: 'string' };
    const out = generateOpenApiClient(genDoc(schema));
    expect(out).toContain('string');
  });

  it('maps integer to number', () => {
    const out = generateOpenApiClient(genDoc({ type: 'integer' }));
    expect(out).toContain('number');
  });

  it('maps boolean', () => {
    const out = generateOpenApiClient(genDoc({ type: 'boolean' }));
    expect(out).toContain('boolean');
  });

  it('maps null', () => {
    const out = generateOpenApiClient(genDoc({ type: 'null' }));
    expect(out).toContain('null');
  });

  it('maps array of items', () => {
    const out = generateOpenApiClient(genDoc({
      type: 'array',
      items: { type: 'string' },
    }));
    expect(out).toContain('string[]');
  });

  it('maps object with properties and required', () => {
    const out = generateOpenApiClient(genDoc({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    }));
    expect(out).toContain("'name': string");
    expect(out).toContain("'age'?: number");
  });

  it('maps additionalProperties: true', () => {
    const out = generateOpenApiClient(genDoc({
      type: 'object',
      additionalProperties: true,
    }));
    expect(out).toContain('Record<string, unknown>');
  });

  it('maps additionalProperties: false', () => {
    const out = generateOpenApiClient(genDoc({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    }));
    // 'a' is optional (not in required) and no Record<...> added.
    expect(out).toContain("'a'?: string");
    expect(out).not.toContain('Record');
  });

  it('maps additionalProperties as schema', () => {
    const out = generateOpenApiClient(genDoc({
      type: 'object',
      additionalProperties: { type: 'number' },
    }));
    expect(out).toContain('Record<string, number>');
  });

  it('maps enum to union', () => {
    const out = generateOpenApiClient(genDoc({
      enum: ['admin', 'user', 'guest'],
    }));
    expect(out).toContain("'admin' | 'user' | 'guest'");
  });

  it('maps const to literal', () => {
    const out = generateOpenApiClient(genDoc({ const: 42 }));
    expect(out).toContain('42');
  });

  it('maps anyOf to union (nullable)', () => {
    const out = generateOpenApiClient(genDoc({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    }));
    expect(out).toContain('string | null');
  });

  it('maps allOf to intersection', () => {
    const out = generateOpenApiClient(genDoc({
      allOf: [{ type: 'string' }, { type: 'number' }],
    }));
    expect(out).toContain('string & number');
  });

  it('maps oneOf to union', () => {
    const out = generateOpenApiClient(genDoc({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    }));
    expect(out).toContain('string | number');
  });

  it('maps type array to union', () => {
    const out = generateOpenApiClient(genDoc({
      type: ['string', 'null'],
    }));
    expect(out).toContain('string | null');
  });

  it('maps array without items to unknown[]', () => {
    const out = generateOpenApiClient(genDoc({
      type: 'array',
    }));
    expect(out).toContain('unknown[]');
  });

  it('maps $ref to component type name', () => {
    const refSchema: SdkOpenApiSchema = {
      $ref: '#/components/schemas/User',
    };
    const out = generateOpenApiClient(
      makeDoc(
        {
          '/x': {
            get: makeOp('x', {
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: refSchema } },
                },
              },
            }),
          },
        },
        { User: { type: 'object' } },
      ),
    );
    expect(out).toContain('export type User = ');
  });

  it('maps empty schema to unknown', () => {
    const out = generateOpenApiClient(genDoc({}));
    expect(out).toContain('unknown');
  });

  it('maps enum with number values', () => {
    const out = generateOpenApiClient(genDoc({ enum: [0, 1, 2] }));
    expect(out).toContain('0 | 1 | 2');
  });

  it('maps enum with boolean values', () => {
    const out = generateOpenApiClient(genDoc({ enum: [true, false] }));
    expect(out).toContain('true | false');
  });

  it('maps enum with null value', () => {
    const out = generateOpenApiClient(genDoc({ enum: [null] }));
    expect(out).toContain('null');
  });

  it('guards against circular $ref by returning unknown', () => {
    const circularSchema: SdkOpenApiSchema = {
      type: 'object',
      properties: {
        self: { $ref: '#/components/schemas/Circular' },
      },
    };
    const out = generateOpenApiClient(
      makeDoc(
        {
          '/x': {
            get: makeOp('x', {
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: circularSchema } },
                },
              },
            }),
          },
        },
        { Circular: circularSchema },
      ),
    );
    // The generated output should not hang and should contain the type.
    expect(out).toContain('Circular');
  });
});

describe('identifier sanitization in generated code', () => {
  it('handles path params with braces', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        get: makeOp('getUserById', {
          parameters: [makeParam('id', 'path')],
        }),
      },
    }));
    expect(out).toContain('getUserById');
    expect(out).toContain('encodeURIComponent');
  });

  it('handles digit-leading operationIds', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': { get: makeOp('123abc') },
    }));
    expect(out).toContain('n123abc');
  });

  it('handles operationId that sanitizes to nothing', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': { get: makeOp('---') },
    }));
    expect(out).toContain('operation');
  });
});

describe('OpenApiCodegenError diagnostics', () => {
  it('throws on missing operationId with path/method', () => {
    let error: OpenApiCodegenError | undefined;
    try {
      generateOpenApiClient(makeDoc({
        '/x': { get: { responses: { '200': { description: 'OK' } } } },
      }));
    } catch (e) {
      error = e as OpenApiCodegenError;
    }
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(OpenApiCodegenError);
    expect(error!.path).toBe('/x');
    expect(error!.method).toBe('get');
  });

  it('throws on cookie parameter location', () => {
    let error: OpenApiCodegenError | undefined;
    try {
      generateOpenApiClient(makeDoc({
        '/x': {
          get: makeOp('x', {
            parameters: [{ name: 'sid', in: 'cookie' }],
          }),
        },
      }));
    } catch (e) {
      error = e as OpenApiCodegenError;
    }
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(OpenApiCodegenError);
    expect(error!.path).toBe('/x');
    expect(error!.method).toBe('get');
  });

  it('throws on duplicate operation names from slug collision', () => {
    let error: OpenApiCodegenError | undefined;
    try {
      generateOpenApiClient(makeDoc({
        '/a-b/c': { get: makeOp('get-a-b-c') },
        '/a/b-c': { get: makeOp('get-a-b-c') },
      }));
    } catch (e) {
      error = e as OpenApiCodegenError;
    }
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(OpenApiCodegenError);
    expect(error!.path).toBe('/a/b-c');
    expect(error!.method).toBe('get');
  });

  it('throws on duplicate sanitized names', () => {
    let error: OpenApiCodegenError | undefined;
    try {
      generateOpenApiClient(makeDoc({
        '/a': { get: makeOp('get-users-{id}') },
        '/b': { post: makeOp('get_users_id') },
      }));
    } catch (e) {
      error = e as OpenApiCodegenError;
    }
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(OpenApiCodegenError);
    expect(error!.path).toBe('/b');
    expect(error!.method).toBe('post');
  });

  it('throws on invalid $ref ending with slash', () => {
    let error: OpenApiCodegenError | undefined;
    try {
      generateOpenApiClient(makeDoc({
        '/x': {
          get: makeOp('x', {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': { schema: { $ref: 'bad/' } },
                },
              },
            },
          }),
        },
      }));
    } catch (e) {
      error = e as OpenApiCodegenError;
    }
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(OpenApiCodegenError);
    expect(error!.path).toBe('/x');
    expect(error!.method).toBe('get');
  });
});

describe('options', () => {
  it('factoryName changes the exported function name', () => {
    const out = generateOpenApiClient(
      makeDoc({ '/x': { get: makeOp('x') } }),
      { factoryName: 'createMyApi' },
    );
    expect(out).toContain('export function createMyApi');
    expect(out).not.toContain('export function createApi');
  });

  it('sdkImport changes the import specifier', () => {
    const out = generateOpenApiClient(
      makeDoc({ '/x': { get: makeOp('x') } }),
      { sdkImport: '@my/sdk' },
    );
    expect(out).toContain("'@my/sdk'");
  });
});

describe('generated method signatures', () => {
  it('generates method with path params only', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        get: makeOp('getUser', {
          parameters: [makeParam('id', 'path')],
        }),
      },
    }));
    // Interior camelCase survives derivation: `getUser`, not `getuser`.
    expect(out).toContain('getUser(id: string):');
  });

  it('generates method with query params but no path params', () => {
    const out = generateOpenApiClient(makeDoc({
      '/search': {
        get: makeOp('search', {
          parameters: [makeParam('q', 'query')],
        }),
      },
    }));
    expect(out).toContain('query:');
  });

  it('generates method with body and path params uses opts', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        post: makeOp('updateUser', {
          parameters: [makeParam('id', 'path')],
          requestBody: makeBody({ type: 'object' }),
        }),
      },
    }));
    expect(out).toContain('json:');
  });

  it('query params use opts when path params present', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        get: makeOp('getUser', {
          parameters: [makeParam('id', 'path'), makeParam('q', 'query')],
        }),
      },
    }));
    // `q` is required, so `opts` itself is required and needs no optional chain.
    expect(out).toContain('opts.q');
  });

  it('query params use opts when no path params', () => {
    const out = generateOpenApiClient(makeDoc({
      '/search': {
        get: makeOp('search', {
          parameters: [makeParam('q', 'query')],
        }),
      },
    }));
    expect(out).toContain('opts.q');
  });

  it('header params use opts when path params present', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        get: makeOp('getUser', {
          parameters: [makeParam('id', 'path'), makeParam('Auth', 'header')],
        }),
      },
    }));
    expect(out).toContain('opts.auth');
  });

  it('body uses opts when path params present', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        post: makeOp('updateUser', {
          parameters: [makeParam('id', 'path')],
          requestBody: makeBody({ type: 'object' }),
        }),
      },
    }));
    // `makeBody` marks the body required, so `opts` is required too.
    expect(out).toContain('opts.body');
  });

  it('body uses opts when no path params', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users': {
        post: makeOp('createUser', {
          requestBody: makeBody({ type: 'object' }),
        }),
      },
    }));
    expect(out).toContain('opts.body');
  });
});

describe('renderSchema edge cases', () => {
  it('maps const value directly', () => {
    const out = generateOpenApiClient(genDoc({ const: 'hello' }));
    expect(out).toContain("'hello'");
  });

  it('maps enum values to union', () => {
    const out = generateOpenApiClient(genDoc({
      type: 'string',
      enum: ['a', 'b', 'c'],
    }));
    expect(out).toContain("'a' | 'b' | 'c'");
  });

  it('maps $ref without components to string', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        get: makeOp('x', {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Missing' } },
              },
            },
          },
        }),
      },
    }));
    // A dangling $ref still renders as the derived PascalCase type name; the
    // generated file then fails to compile, which is the actionable outcome.
    expect(out).toContain('Missing');
  });
});

describe('determinism', () => {
  it('same input produces identical output', () => {
    const d = makeDoc({
      '/users': { get: makeOp('listUsers') },
      '/users/{id}': {
        get: makeOp('getUser', {
          parameters: [makeParam('id', 'path')],
        }),
      },
    });
    expect(generateOpenApiClient(d)).toBe(generateOpenApiClient(d));
  });
});

describe('parameter and body rendering', () => {
  it('includes query params in generated request', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        get: makeOp('x', { parameters: [makeParam('q', 'query')] }),
      },
    }));
    expect(out).toContain('query:');
  });

  it('includes headers in generated request', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        get: makeOp('x', { parameters: [makeParam('Auth', 'header')] }),
      },
    }));
    expect(out).toContain('headers:');
  });

  it('includes JSON body in generated request', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        post: makeOp('x', { requestBody: makeBody({ type: 'object' }) }),
      },
    }));
    expect(out).toContain('json:');
  });

  // N1 regression: wire key must be the original OpenAPI name, not sanitized
  it('uses original name as wire key for camelCase query param', () => {
    const doc = makeDoc({
      '/x': {
        get: makeOp('x', {
          parameters: [{
            name: 'createdAt',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          }],
        }),
      },
    });
    const out = generateOpenApiClient(doc);
    // Wire key stays the original `createdAt`; the field is accessed by its
    // derived identifier, which preserves the interior casing. No cast is emitted.
    expect(out).toContain("'createdAt': opts?.createdAt");
  });

  it('uses original name as wire key for underscore query param', () => {
    const doc = makeDoc({
      '/x': {
        get: makeOp('x', {
          parameters: [{
            name: 'user_id',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          }],
        }),
      },
    });
    const out = generateOpenApiClient(doc);
    // Wire key stays the original `user_id`; the field is `userId`.
    expect(out).toContain("'user_id': opts?.userId");
  });

  it('uses original name as wire key for hyphenated header', () => {
    const doc = makeDoc({
      '/x': {
        get: makeOp('x', {
          parameters: [{
            name: 'X-API-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          }],
        }),
      },
    });
    const out = generateOpenApiClient(doc);
    // Wire key stays the original `X-API-Key`; the acronym survives derivation.
    expect(out).toContain("'X-API-Key'");
    expect(out).toContain('opts?.xAPIKey');
    expect(out).toContain('headers:');
    // No dead cast is emitted around the field access.
    expect(out).not.toContain('as string | undefined');
  });
});

describe('response types', () => {
  it('void for 204 no content', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        delete: makeOp('x', {
          responses: { '204': { description: 'Deleted' } },
        }),
      },
    }));
    expect(out).toContain('void');
  });

  it('typed response for 200 with schema', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        get: makeOp('x', {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { type: 'string' } },
              },
            },
          },
        }),
      },
    }));
    expect(out).toContain('string');
  });
});

describe('component schemas', () => {
  it('emits component type declarations', () => {
    const out = generateOpenApiClient(
      makeDoc({ '/x': { get: makeOp('x') } }, { User: { type: 'object' } }),
    );
    expect(out).toContain('export type User = ');
  });
  it('generates factory with multiple operations on different paths', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users': { get: makeOp('listUsers') },
      '/users/{id}': {
        get: makeOp('getUserById', {
          parameters: [makeParam('id', 'path')],
        }),
      },
      '/posts': {
        post: makeOp('createPost', {
          requestBody: makeBody({ type: 'object' }),
        }),
      },
    }));
    // Operation names keep their interior camelCase.
    expect(out).toContain('listUsers,');
    expect(out).toContain('getUserById,');
    expect(out).toContain('createPost,');
    expect(out).toContain('return {');
  });

  it('generates void return type for operation with no responses', () => {
    const opWithoutResponses: SdkOpenApiOperation = {
      operationId: 'x',
    };
    const out = generateOpenApiClient(makeDoc({
      '/x': { delete: opWithoutResponses },
    }));
    expect(out).toContain('void');
  });

  it('generates correct return type for multiple 2xx responses', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        get: makeOp('x', {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { type: 'string' } },
              },
            },
            '201': {
              description: 'Created',
              content: {
                'application/json': { schema: { type: 'number' } },
              },
            },
          },
        }),
      },
    }));
    expect(out).toContain('string | number');
  });
});

/**
 * Inline (non-`$ref`) schemas are hoisted, so no use site carries a multi-line
 * object literal (M70m/X11-9, found in verification).
 *
 * A rendered type lands at several indentation levels, and a success type lands
 * at TWO of them at once — the `Api` signature and the `client.request<…>`
 * argument — so no single indent is correct for a multi-line object and
 * `deno fmt` reindented whatever was emitted. Both committed fixtures name
 * every schema through `$ref`, which is why neither could show it.
 */
/**
 * Findings from the automated review of PR #181.
 */
describe('review findings (PR #181)', () => {
  const withResponses = (responses: Record<string, unknown>) =>
    ({
      openapi: '3.1.0',
      paths: { '/a': { get: { operationId: 'get-a', responses } } },
    }) as unknown as SdkOpenApiDocument;

  it('skips a range code instead of reading its leading digit as a status', () => {
    // `parseInt('4XX', 10)` is 4, so the previous `Number.isFinite` guard let a
    // range code through as a `status: 4` arm that no response can carry —
    // leaving a real 404 unnarrowed.
    const out = generateOpenApiClient(
      withResponses({
        '200': { description: 'ok' },
        '4XX': {
          description: 'range',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
        default: { description: 'def' },
      }),
      {},
    );

    expect(out).not.toMatch(/status: 4\b/);
    expect(out).not.toContain('e.status === 4');
    expect(out).not.toContain('GetAError');
  });

  it('does not read a 2xx range code as an error arm either', () => {
    const out = generateOpenApiClient(
      withResponses({
        '2XX': {
          description: 'range',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
      }),
      {},
    );

    expect(out).not.toContain('e.status === 2');
  });

  it('wraps an over-width guard rather than emitting a 140-column line', () => {
    const responses: Record<string, unknown> = { '200': { description: 'ok' } };
    for (const code of ['400', '401', '403', '404', '409']) {
      responses[code] = {
        description: code,
        content: { 'application/json': { schema: { type: 'string' } } },
      };
    }
    const out = generateOpenApiClient(withResponses(responses), {});

    expect(out.split('\n').filter((l) => l.length > 100)).toEqual([]);
    expect(out).toContain('  if (!(e instanceof HttpClientError)) return false;');
    expect(out).toContain('    e.status === 400 ||');
    expect(out).toContain('    e.status === 409\n');
  });

  it('keeps a guard that fits on one line', () => {
    const out = generateOpenApiClient(
      withResponses({
        '200': { description: 'ok' },
        '404': {
          description: 'nf',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
      }),
      {},
    );

    expect(out).toContain('return e instanceof HttpClientError && (e.status === 404);');
  });

  it('honours additionalProperties on an object declaring an empty properties map', () => {
    // Two spellings of one schema must not contradict each other: reading
    // `properties: {}` as closed emitted `Record<PropertyKey, never>`, which
    // rejects every payload the schema accepts.
    const body = (schema: unknown) =>
      ({
        openapi: '3.1.0',
        paths: {
          '/b': {
            post: {
              operationId: 'post-b',
              requestBody: { required: true, content: { 'application/json': { schema } } },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }) as unknown as SdkOpenApiDocument;

    const empty = generateOpenApiClient(
      body({ type: 'object', properties: {}, additionalProperties: true }),
      {},
    );
    const absent = generateOpenApiClient(
      body({ type: 'object', additionalProperties: true }),
      {},
    );

    expect(empty).toContain('body: Record<string, unknown>;');
    expect(absent).toContain('body: Record<string, unknown>;');
  });

  it('still emits the closed empty object when nothing else is allowed', () => {
    const closed = (ap: unknown) =>
      ({
        openapi: '3.1.0',
        paths: {
          '/c': {
            post: {
              operationId: 'post-c',
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: {}, ...(ap as object) },
                  },
                },
              },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }) as unknown as SdkOpenApiDocument;

    expect(generateOpenApiClient(closed({}), {}))
      .toContain('body: Record<PropertyKey, never>;');
    expect(generateOpenApiClient(closed({ additionalProperties: false }), {}))
      .toContain('body: Record<PropertyKey, never>;');
  });
});

describe('inline schemas are hoisted (X11-9)', () => {
  it('emits the committed inline-shapes fixture byte-for-byte', () => {
    const generated = generateOpenApiClient(inlineShapesDocument, {
      sdkImport: '../../src/index.ts',
    });
    const fixture = Deno.readTextFileSync(
      new URL('../fixtures/inline-shapes-client.ts', import.meta.url),
    );
    expect(generated).toBe(fixture);
  });

  it('hoists an inline request body out of the Args interface', () => {
    const out = generateOpenApiClient(inlineShapesDocument, {});
    expect(out).toContain('export type PlaceOrderBody = {');
    expect(out).toContain('  body: PlaceOrderBody;');
  });

  it('hoists an inline 2xx response, which is used at two indent levels', () => {
    const out = generateOpenApiClient(inlineShapesDocument, {});
    expect(out).toContain('export type PlaceOrderResponse201 = {');
    expect(out).toContain('Promise<ClientResponse<PlaceOrderResponse201>>');
    expect(out).toContain('client.request<PlaceOrderResponse201>(');
  });

  it('hoists an inline parameter schema', () => {
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/search': {
          get: {
            operationId: 'run-search',
            parameters: [{
              name: 'filter',
              in: 'query',
              schema: {
                type: 'object',
                properties: { a: { type: 'string' } },
                required: ['a'],
              },
            }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    } as const;
    const out = generateOpenApiClient(doc as unknown as SdkOpenApiDocument, {});
    expect(out).toContain('export type RunSearchFilterParam = {');
    expect(out).toContain('  filter?: RunSearchFilterParam;');
  });

  /**
   * The property that makes the three cases above one rule rather than three
   * patches: after hoisting, NO emitted use site opens an object literal, so
   * there is no indentation for `deno fmt` to disagree with. A declaration
   * opens one with `= {`, never `: {`.
   */
  it('leaves no use site opening a multi-line object literal', () => {
    for (const doc of [inlineShapesDocument, usersDocument, paramsDocument]) {
      const out = generateOpenApiClient(doc, {});
      expect(out).not.toMatch(/: \{\n/);
    }
  });
});

describe('fixture equality', () => {
  it('generateOpenApiClient output equals the committed fixture', () => {
    const generated = generateOpenApiClient(usersDocument, { sdkImport: '../../src/index.ts' });
    const fixture = Deno.readTextFileSync(
      new URL('../fixtures/generated-client.ts', import.meta.url),
    );
    expect(generated).toBe(fixture);
  });
});

/**
 * Compile regressions are pinned by a COMMITTED fixture, not by shelling out to
 * `deno check` on a temp file.
 *
 * `packages/sdk/test/fixtures/params-client.ts` is real generator output for
 * `paramsDocument`, and `deno task check` type-checks `test/` (verified), so any
 * emitted shape that does not compile fails one of the repo's four gates. The
 * previous subprocess approach needed `--allow-write` and `--allow-run`, which
 * the `test` task does not grant, so the whole suite errored out — and a
 * subprocess `deno check` would not have caught the emitted source disagreeing
 * with the SDK's own `IHttpClient` contract anyway, because the temp file was
 * checked in isolation against a bare `@setu-ts/sdk` specifier.
 */
describe('compile regression', () => {
  const generated = generateOpenApiClient(paramsDocument, { sdkImport: '../../src/index.ts' });

  it('emits the committed params fixture byte-for-byte', () => {
    const fixture = Deno.readTextFileSync(
      new URL('../fixtures/params-client.ts', import.meta.url),
    );
    expect(generated).toBe(fixture);
  });

  it('stringifies a non-string (integer) header parameter', () => {
    // A header value must reach `Headers` as a string; `String(...)` is what makes
    // an `integer` header schema compile against `Record<string, string>`.
    // M70m/X11-9: the guard is braced and 2-space indented, so the emitted
    // source round-trips through `deno fmt` unchanged.
    expect(generated).toContain('if (opts?.xRetryCount !== undefined) {');
    expect(generated).toContain(
      "headers['X-Retry-Count'] = String(opts?.xRetryCount);",
    );
  });

  it('defaults a schemaless path parameter to string', () => {
    expect(generated).toContain('function getUserById(id: string)');
  });

  it('defaults schemaless query and header parameters to string', () => {
    expect(generated).toContain('\n  q?: string;');
    expect(generated).toContain('\n  xCustom?: string;');
  });

  it('substitutes a placeholder that shares a segment with literal text', () => {
    // `{fileId}.json` is not a whole segment. An anchored `^\{(.+)\}$` match
    // emitted it as the LITERAL text `{fileId}.json`, silently dropping the
    // substitution and requesting a nonexistent path.
    expect(generated).toContain(
      'path: `tenants/${encodeURIComponent(tenantId)}/files/${encodeURIComponent(fileId)}.json`,',
    );
    expect(generated).not.toContain('{fileId}');
  });

  it('preserves interior camelCase in derived operation names', () => {
    expect(generated).toContain('function searchEverything(');
    expect(generated).toContain('function downloadFileMetadata(');
    // The whole-part lower-casing this replaced emitted `searcheverything`.
    expect(generated).not.toContain('searcheverything');
  });

  it('emits PascalCase type names for components and argument interfaces', () => {
    expect(generated).toContain('export type User = {');
    expect(generated).toContain('export interface SearchEverythingArgs {');
    expect(generated).not.toContain('export type user =');
  });

  it('makes opts required when a query parameter or the body is required', () => {
    expect(generated).toContain('function createReport(opts: CreateReportArgs)');
    expect(generated).toContain('\n  body: User;');
    // Required fields are read without an optional chain.
    expect(generated).toContain("query: { 'format': opts.format },");
    expect(generated).toContain('json: opts.body,');
  });

  it('keeps opts optional when every field is optional', () => {
    expect(generated).toContain('function updateNote(opts?: UpdateNoteArgs)');
    expect(generated).toContain('\n  body?: Record<string, unknown>;');
    expect(generated).toContain('json: opts?.body,');
  });

  it('emits a plain string literal for a path with no placeholders', () => {
    expect(generated).toContain("path: 'search',");
    expect(generated).not.toContain('path: `search`,');
  });
});

describe('hostile path templates', () => {
  function pathLine(template: string, params: string[]): string {
    const out = generateOpenApiClient(makeDoc({
      [template]: {
        get: makeOp('op', {
          parameters: params.map((n) => makeParam(n, 'path')),
          responses: { '204': { description: 'No Content' } },
        }),
      },
    }));
    return out.split('\n').find((l) => l.includes('path:'))!.trim();
  }

  it('substitutes a placeholder followed by literal text in the same segment', () => {
    expect(pathLine('/files/{id}.json', ['id'])).toBe(
      'path: `files/${encodeURIComponent(id)}.json`,',
    );
  });

  it('substitutes two placeholders inside one segment', () => {
    // A greedy `^\{(.+)\}$` match would treat `{x}y{z}` as ONE placeholder named
    // `x}y{z`, deriving the nonsense identifier `xYZ`.
    expect(pathLine('/a/{x}y{z}/b', ['x', 'z'])).toBe(
      'path: `a/${encodeURIComponent(x)}y${encodeURIComponent(z)}/b`,',
    );
  });

  it('escapes a backtick in the literal text so the template literal cannot be broken out of', () => {
    expect(pathLine('/back`tick/{id}', ['id'])).toBe(
      'path: `back\\`tick/${encodeURIComponent(id)}`,',
    );
  });

  it('escapes a literal dollar sign that precedes a placeholder', () => {
    // Without escaping, the literal `$` would fuse with the emitted `${` and
    // inject an unintended substitution.
    expect(pathLine('/dollar${x}/{id}', ['x', 'id'])).toBe(
      'path: `dollar\\$${encodeURIComponent(x)}/${encodeURIComponent(id)}`,',
    );
  });

  it('escapes a backslash in the literal text', () => {
    expect(pathLine('/back\\slash/{id}', ['id'])).toBe(
      'path: `back\\\\slash/${encodeURIComponent(id)}`,',
    );
  });

  it('throws on a duplicate component type name naming both originals', () => {
    expect(() =>
      generateOpenApiClient(
        makeDoc({ '/x': { get: makeOp('x') } }, {
          User: { type: 'object' },
          user: { type: 'object' },
        }),
      )
    ).toThrow(/Duplicate generated type name 'User'.*'User'.*'user'/);
  });
});

describe('generated-source injection hardening', () => {
  it('neutralizes a comment terminator in an operationId', () => {
    // An operationId carrying `*/` closed the emitted JSDoc comment early and the
    // remainder became EXECUTABLE code in the factory body. The payload
    // type-checked and ran, so no gate caught it.
    const payload = 'ok*/Object.assign(globalThis,{PWNED:1});/*';
    const out = generateOpenApiClient(makeDoc({
      '/x': { get: makeOp(payload, { responses: { '204': { description: '' } } }) },
    }));
    const comment = out.split('\n').find((l) => l.includes('Object.assign'))!;
    // The terminator is escaped, so the payload stays inside the comment.
    expect(comment).toContain('ok*\\/Object.assign');
    expect(comment).not.toContain('ok*/Object.assign');
    // Nothing between the comment open and the function declaration is a statement.
    expect(out).not.toMatch(/\*\/\s*Object\.assign/);
  });

  it('collapses newlines in an operationId so it cannot escape the comment', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': {
        get: makeOp('line1\nglobalThis.X=1;', { responses: { '204': { description: '' } } }),
      },
    }));
    // The `Api` interface also carries a `line1…` member now, so match the
    // COMMENT line specifically rather than the first line mentioning it.
    const comment = out.split('\n').find((l) => l.trim().startsWith('/**') && l.includes('line1'))!;
    expect(comment).toContain('line1 globalThis.X=1;');
    expect(comment.trim().endsWith('*/')).toBe(true);
  });
});

describe('path template / parameter agreement', () => {
  it('throws when a placeholder has no matching path parameter', () => {
    // Previously emitted `encodeURIComponent(id)` with no `id` argument, so the
    // generated file failed to compile with TS2304 and no diagnostic named the op.
    expect(() =>
      generateOpenApiClient(makeDoc({
        '/users/{id}': { get: makeOp('getUser') },
      }))
    ).toThrow(/placeholder '\{id\}' with no matching 'in: path' parameter/);
  });

  it('throws when a declared path parameter is absent from the template', () => {
    // Previously emitted an unused positional argument, silently dropping the value.
    expect(() =>
      generateOpenApiClient(makeDoc({
        '/users': {
          get: makeOp('getUser', { parameters: [makeParam('id', 'path')] }),
        },
      }))
    ).toThrow(/declared 'in: path' but does not appear in the path template/);
  });

  it('throws when two placeholders derive onto one argument name', () => {
    expect(() =>
      generateOpenApiClient(makeDoc({
        '/a/{user-id}/{user_id}': {
          get: makeOp('op', { parameters: [makeParam('user-id', 'path')] }),
        },
      }))
    ).toThrow(/two placeholders deriving onto one argument 'userId'/);
  });

  it('accepts a placeholder whose name needs sanitizing', () => {
    const out = generateOpenApiClient(makeDoc({
      '/a/{user-id}': { get: makeOp('op', { parameters: [makeParam('user-id', 'path')] }) },
    }));
    expect(out).toContain('function op(userId: string)');
    expect(out).toContain('path: `a/${encodeURIComponent(userId)}`,');
  });
});

describe('path-item level operations and parameters', () => {
  it('emits a trace operation', () => {
    // `trace` is declared on SdkOpenApiPathItem but was missing from HTTP_METHODS,
    // so the operation was dropped with no method and no diagnostic.
    const out = generateOpenApiClient(makeDoc({
      '/t': { trace: makeOp('traceIt', { responses: { '204': { description: '' } } }) },
    }));
    expect(out).toContain('function traceIt(');
    expect(out).toContain("method: 'TRACE',");
    expect(out).toContain('traceIt,');
  });

  it('merges path-item-level parameters into each operation', () => {
    // `SdkOpenApiPathItem.parameters` was never read, so a shared PATH parameter
    // vanished and the emitted source referenced an undeclared identifier.
    const out = generateOpenApiClient(makeDoc({
      '/tenants/{tid}/x': {
        parameters: [makeParam('tid', 'path')],
        get: makeOp('sharedGet'),
        delete: makeOp('sharedDelete'),
      },
    }));
    expect(out).toContain('function sharedGet(tid: string)');
    expect(out).toContain('function sharedDelete(tid: string)');
    expect(out).toContain('path: `tenants/${encodeURIComponent(tid)}/x`,');
  });

  it('lets an operation-level parameter override a shared one of the same name and location', () => {
    const out = generateOpenApiClient(makeDoc({
      '/a/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: makeOp('ovr', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        }),
      },
    }));
    // The operation's `integer` schema wins over the shared `string`.
    expect(out).toContain('function ovr(id: number)');
  });

  it('keeps a shared parameter that the operation does not redeclare', () => {
    const out = generateOpenApiClient(makeDoc({
      '/a': {
        parameters: [{ name: 'shared', in: 'query', required: false, schema: { type: 'string' } }],
        get: makeOp('mixed', {
          parameters: [{ name: 'own', in: 'query', required: false, schema: { type: 'string' } }],
        }),
      },
    }));
    expect(out).toContain('\n  shared?: string;');
    expect(out).toContain('\n  own?: string;');
  });
});

describe('Api interface and explicit return type (X11-4)', () => {
  const doc = makeDoc({
    '/users': { get: makeOp('listUsers', { responses: { '200': { description: 'OK' } } }) },
  });

  it('emits a named interface and returns it from the factory', () => {
    // An INFERRED return type is a JSR slow type: it blocks `.d.ts`
    // generation, so a consumer could not publish a package containing the
    // generated file — while its own header tells them not to edit it.
    const out = generateOpenApiClient(doc);

    expect(out).toContain('export interface Api {');
    expect(out).toContain('  listUsers(): Promise<ClientResponse<void>>;');
    expect(out).toContain('export function createApi(client: IHttpClient): Api {');
  });

  it('renames both the interface and the return type through apiTypeName', () => {
    const out = generateOpenApiClient(doc, { apiTypeName: 'OrdersClient' });

    expect(out).toContain('export interface OrdersClient {');
    expect(out).toContain('export function createApi(client: IHttpClient): OrdersClient {');
    expect(out).not.toContain('export interface Api {');
  });

  it('sanitizes a hostile apiTypeName rather than emitting it raw', () => {
    const out = generateOpenApiClient(doc, { apiTypeName: 'my api!' });

    expect(out).toContain('export interface MyApi {');
  });

  it('throws when a component schema collides with the Api interface name', () => {
    expect(() =>
      generateOpenApiClient(
        makeDoc({ '/x': { get: makeOp('x', { responses: {} }) } }, {
          Api: { type: 'object' },
        }),
      )
    ).toThrow(/Duplicate generated type name 'Api'/);
  });

  it('throws when a component schema collides with a generated Args name', () => {
    // The registry used to cover component schemas ALONE, so a component named
    // `ListUsersArgs` beside an operation `listUsers` emitted two declarations
    // of one name — a syntax error in the generated file.
    expect(() =>
      generateOpenApiClient(
        makeDoc({
          '/users': {
            get: makeOp('listUsers', {
              parameters: [{ name: 'page', in: 'query', schema: { type: 'string' } }],
              responses: {},
            }),
          },
        }, { ListUsersArgs: { type: 'object' } }),
      )
    ).toThrow(/Duplicate generated type name 'ListUsersArgs'/);
  });

  it('claims no Args name for an operation that takes no args', () => {
    // An operation with no `opts` emits no interface, so it must not reserve
    // the name either — that would refuse a legitimate component schema.
    const out = generateOpenApiClient(
      makeDoc({ '/users': { get: makeOp('listUsers', { responses: {} }) } }, {
        ListUsersArgs: { type: 'object', properties: { a: { type: 'string' } } },
      }),
    );

    expect(out).toContain('export type ListUsersArgs = {');
  });
});

describe('typed error responses (X11-7)', () => {
  function errDoc(responses: Record<string, unknown>) {
    return makeDoc({
      '/users/{id}': {
        get: makeOp('getUserById', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: responses as never,
        }),
      },
    });
  }

  it('emits a status-discriminated union and a narrowing guard', () => {
    const out = generateOpenApiClient(errDoc({
      '200': { description: 'OK' },
      '404': {
        description: 'Not found',
        content: { 'application/json': { schema: { type: 'string' } } },
      },
      '409': {
        description: 'Conflict',
        content: { 'application/json': { schema: { type: 'number' } } },
      },
    }));

    expect(out).toContain('export type GetUserByIdError =');
    expect(out).toContain('  | (HttpClientError<string> & { readonly status: 404 })');
    expect(out).toContain('  | (HttpClientError<number> & { readonly status: 409 });');
    expect(out).toContain(
      'export function isGetUserByIdError(e: unknown): e is GetUserByIdError {',
    );
    expect(out).toContain('return e instanceof HttpClientError && (e.status === 404 ||');
  });

  it('emits a single-arm error type WITHOUT union punctuation', () => {
    // `deno fmt` strips the leading `|` and the parentheses from a one-arm
    // union, so emitting them would fail the fmt gate (probed).
    const out = generateOpenApiClient(errDoc({
      '200': { description: 'OK' },
      '404': {
        description: 'Not found',
        content: { 'application/json': { schema: { type: 'string' } } },
      },
    }));

    expect(out).toContain(
      'export type GetUserByIdError = HttpClientError<string> & { readonly status: 404 };',
    );
  });

  it('hoists a MULTI-LINE error body into its own alias', () => {
    // Keeps every union arm on one line; an inline object would make `deno fmt`
    // rewrite the intersection into a leading-`&` block.
    const out = generateOpenApiClient(errDoc({
      '200': { description: 'OK' },
      '422': {
        description: 'Unprocessable',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { field: { type: 'string' } } },
          },
        },
      },
    }));

    expect(out).toContain('export type GetUserByIdError422Body = {');
    expect(out).toContain(
      'export type GetUserByIdError = HttpClientError<GetUserByIdError422Body> & ' +
        '{ readonly status: 422 };',
    );
  });

  it('types a declared error with NO json content as unknown', () => {
    const out = generateOpenApiClient(errDoc({
      '200': { description: 'OK' },
      '503': { description: 'Unavailable' },
    }));

    expect(out).toContain(
      'export type GetUserByIdError = HttpClientError<unknown> & { readonly status: 503 };',
    );
  });

  it('emits nothing for an operation with only 2xx responses', () => {
    // An exported type nothing references is dead surface.
    const out = generateOpenApiClient(errDoc({ '200': { description: 'OK' } }));

    expect(out).not.toContain('GetUserByIdError');
    expect(out).not.toContain('import { HttpClientError }');
  });

  it('ignores a `default` response, which names no single status', () => {
    const out = generateOpenApiClient(errDoc({
      '200': { description: 'OK' },
      default: { description: 'Anything' },
    }));

    expect(out).not.toContain('GetUserByIdError');
  });

  it('imports HttpClientError as a VALUE, since the guard uses instanceof', () => {
    const out = generateOpenApiClient(errDoc({
      '404': {
        description: 'Not found',
        content: { 'application/json': { schema: { type: 'string' } } },
      },
    }));

    expect(out).toContain("import { HttpClientError } from '@setu-ts/sdk';");
    expect(out).toContain("import type { ClientResponse, IHttpClient } from '@setu-ts/sdk';");
  });
});

describe('emitted formatting (X11-9)', () => {
  it('emits no lint pragma at all', () => {
    // A blanket ignore hid `{}`; a NARROWED one cannot be emitted
    // unconditionally either, because `deno lint` reports an ignore that
    // matches nothing as `ban-unused-ignore`.
    const out = generateOpenApiClient(makeDoc({
      '/x': { get: makeOp('x', { responses: {} }) },
    }));

    expect(out).not.toContain('deno-lint-ignore');
  });

  it('emits Record<PropertyKey, never> rather than the ban-types `{}`', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': { get: makeOp('x', { responses: {} }) },
    }, {
      Closed: { type: 'object', additionalProperties: false },
      NoProps: { type: 'object', properties: {} },
    }));

    expect(out).toContain('export type Closed = Record<PropertyKey, never>;');
    expect(out).toContain('export type NoProps = Record<PropertyKey, never>;');
  });

  it('indents a NESTED inline object type', () => {
    const out = generateOpenApiClient(makeDoc({
      '/x': { get: makeOp('x', { responses: {} }) },
    }, {
      Outer: {
        type: 'object',
        properties: {
          inner: { type: 'object', properties: { deep: { type: 'string' } } },
        },
      },
    }));

    expect(out).toContain("  'inner'?: {\n    'deep'?: string;\n  };");
  });

  it('wraps a long signature one parameter per line, as deno fmt does', () => {
    const out = generateOpenApiClient(makeDoc({
      '/aaaaaaaaaaaaaaaaaaaaaaaaaaaa/{alphaIdentifier}/{betaIdentifier}/{gammaIdentifier}': {
        get: makeOp('someVeryLongOperationNameIndeed', {
          parameters: [
            { name: 'alphaIdentifier', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'betaIdentifier', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'gammaIdentifier', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {},
        }),
      },
    }));

    expect(out).toContain('  someVeryLongOperationNameIndeed(\n    alphaIdentifier: string,');
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it('emits a long path as an array join rather than a template literal', () => {
    // `deno fmt` rewraps a long template literal by breaking at whichever `${`
    // happens to fit, which no generator can predict. An array `.join('')` is
    // exactly equivalent and wraps one element per line, which fmt leaves
    // alone.
    const out = generateOpenApiClient(makeDoc({
      '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/{alphaIdentifier}/{betaIdentifier}/{gammaIdentifier}': {
        get: makeOp('op', {
          parameters: [
            { name: 'alphaIdentifier', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'betaIdentifier', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'gammaIdentifier', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {},
        }),
      },
    }));

    expect(out).toContain('path: [');
    expect(out).toContain("      ].join(''),");
    expect(out).toContain('        encodeURIComponent(alphaIdentifier),');
    expect(out).not.toContain('path: `');
  });

  it('keeps a SHORT path as a template literal', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        get: makeOp('getUser', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        }),
      },
    }));

    expect(out).toContain('path: `users/${encodeURIComponent(id)}`,');
    expect(out).not.toContain('path: [');
  });

  it('preserves a placeholder sharing a segment with literal text, in BOTH forms', () => {
    // `/files/{id}.json` must not lose the `.json`, and the array form splits
    // literal chunks the same way the template does.
    const shortForm = generateOpenApiClient(makeDoc({
      '/files/{id}.json': {
        get: makeOp('getFile', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        }),
      },
    }));
    expect(shortForm).toContain('path: `files/${encodeURIComponent(id)}.json`,');

    const longForm = generateOpenApiClient(makeDoc({
      '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/{id}.json': {
        get: makeOp('getFile', {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        }),
      },
    }));
    expect(longForm).toContain('        encodeURIComponent(id),');
    expect(longForm).toContain("        '.json',");
  });
});
