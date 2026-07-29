import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { generateOpenApiClient, sanitizeIdentifier } from '../../src/codegen/openapi-codegen.ts';
import { OpenApiCodegenError } from '../../src/errors.ts';
import { paramsDocument } from '../fixtures/params-document.ts';
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

describe('fixture equality', () => {
  it('generateOpenApiClient output equals the committed fixture', () => {
    const doc: SdkOpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            parameters: [
              { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
              { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
              { name: 'X-API-Key', in: 'header', required: false, schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { $ref: '#/components/schemas/User' } },
                  },
                },
              },
            },
          },
        },
        '/users/{id}': {
          get: {
            operationId: 'getUserById',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['id', 'name'],
          },
        },
      },
    };
    const generated = generateOpenApiClient(doc, { sdkImport: '../../src/index.ts' });
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
 * checked in isolation against a bare `@hono-enterprise/sdk` specifier.
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
    expect(generated).toContain(
      "if (opts?.xRetryCount !== undefined) headers['X-Retry-Count'] = String(opts?.xRetryCount);",
    );
  });

  it('defaults a schemaless path parameter to string', () => {
    expect(generated).toContain('function getUserById(id: string)');
  });

  it('defaults schemaless query and header parameters to string', () => {
    expect(generated).toContain('    q?: string;');
    expect(generated).toContain('    xCustom?: string;');
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
    expect(generated).toContain('    body: User;');
    // Required fields are read without an optional chain.
    expect(generated).toContain("query: { 'format': opts.format },");
    expect(generated).toContain('json: opts.body,');
  });

  it('keeps opts optional when every field is optional', () => {
    expect(generated).toContain('function updateNote(opts?: UpdateNoteArgs)');
    expect(generated).toContain('    body?: Record<string, unknown>;');
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
    ).toThrow(/Duplicate component type name 'User'.*'User'.*'user'/);
  });
});
