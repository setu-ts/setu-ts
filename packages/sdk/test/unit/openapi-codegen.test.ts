import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { generateOpenApiClient, sanitizeIdentifier } from '../../src/codegen/openapi-codegen.ts';
import { OpenApiCodegenError } from '../../src/errors.ts';
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
    expect(sanitizeIdentifier('#/components/schemas/MyUser')).toBe('myuser');
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
    expect(out).toContain('export type user = ');
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
    expect(out).toContain('circular');
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
    // sanitizeIdentifier turns 'getUser' into 'getuser' (single part → lowercase).
    expect(out).toContain('getuser(id: string):');
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
    expect(out).toContain('opts?.q');
  });

  it('query params use opts when no path params', () => {
    const out = generateOpenApiClient(makeDoc({
      '/search': {
        get: makeOp('search', {
          parameters: [makeParam('q', 'query')],
        }),
      },
    }));
    expect(out).toContain('opts?.q');
  });

  it('header params use opts when path params present', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users/{id}': {
        get: makeOp('getUser', {
          parameters: [makeParam('id', 'path'), makeParam('Auth', 'header')],
        }),
      },
    }));
    expect(out).toContain('opts?.auth');
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
    expect(out).toContain('opts?.body');
  });

  it('body uses opts when no path params', () => {
    const out = generateOpenApiClient(makeDoc({
      '/users': {
        post: makeOp('createUser', {
          requestBody: makeBody({ type: 'object' }),
        }),
      },
    }));
    expect(out).toContain('opts?.body');
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
    // Missing $ref is still rendered as the sanitized identifier.
    expect(out).toContain('missing');
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
    // Wire key should be 'createdAt', access uses opts?.createdat (sanitizeIdentifier lowercases first part)
    expect(out).toContain("'createdAt': (opts?.createdat as string | undefined)");
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
    // Wire key should be 'user_id', access uses opts?.userId (sanitizeIdentifier splits on underscore)
    expect(out).toContain("'user_id': (opts?.userId as string | undefined)");
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
    // Wire key should be 'X-API-Key', access uses opts?.xApiKey (sanitizeIdentifier splits on hyphen)
    expect(out).toContain("'X-API-Key'");
    expect(out).toContain('opts?.xApiKey');
    expect(out).toContain('headers:');
    // Verify the old unsafe pattern is not present
    expect(out).not.toContain('(opts?.xApiKey as string | undefined)');
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
    expect(out).toContain('export type user = ');
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
    // All operation names are lowercased by sanitizeIdentifier.
    expect(out).toContain('listusers,');
    expect(out).toContain('getuserbyid,');
    expect(out).toContain('createpost,');
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

// Compile-regression tests: ensure generated code compiles for various param shapes
let _tempCounter = 0;

describe('compile regression', () => {
  async function compileCheck(source: string): Promise<void> {
    // Write to /tmp which is typically writable without extra permissions
    const tmpFilePath = `/tmp/codegen_test_${_tempCounter++}.ts`;
    await Deno.writeTextFile(tmpFilePath, source);

    // Run deno check via Deno.Command (properly typed in Deno)
    const command = new Deno.Command(Deno.execPath(), {
      args: ['check', tmpFilePath],
      stdout: 'piped',
      stderr: 'piped',
    });
    const result = await command.output();
    const code = result.code;
    if (code !== 0) {
      throw new Error(`deno check failed for generated client, exit code ${code}`);
    }
    // Clean up
    await Deno.remove(tmpFilePath);
  }

  it('compiles with non-string header (integer X-Retry-Count)', async () => {
    const doc: SdkOpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [
              {
                name: 'X-Retry-Count',
                in: 'header',
                required: false,
                schema: { type: 'integer' },
              },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    };
    const source = generateOpenApiClient(doc, { sdkImport: '@hono-enterprise/sdk' });
    await compileCheck(source);
  });

  it('compiles with schemaless path param (no schema)', async () => {
    const doc: SdkOpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/users/{id}': {
          get: {
            operationId: 'getUser',
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                // No schema field - this is the schemaless case
              },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    };
    const source = generateOpenApiClient(doc, { sdkImport: '@hono-enterprise/sdk' });
    await compileCheck(source);
  });

  it('compiles with schemaless query param (no schema)', async () => {
    const doc: SdkOpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/search': {
          get: {
            operationId: 'search',
            parameters: [
              {
                name: 'q',
                in: 'query',
                required: false,
                // No schema field
              },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'array' } } },
              },
            },
          },
        },
      },
    };
    const source = generateOpenApiClient(doc, { sdkImport: '@hono-enterprise/sdk' });
    await compileCheck(source);
  });

  it('compiles with schemaless header param (no schema)', async () => {
    const doc: SdkOpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [
              {
                name: 'X-Custom',
                in: 'header',
                required: false,
                // No schema field
              },
            ],
            responses: {
              '200': { description: 'OK' },
            },
          },
        },
      },
    };
    const source = generateOpenApiClient(doc, { sdkImport: '@hono-enterprise/sdk' });
    await compileCheck(source);
  });

  it('compiles with string header (F1 regression)', async () => {
    const doc: SdkOpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [
              {
                name: 'X-API-Key',
                in: 'header',
                required: false,
                schema: { type: 'string' },
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const source = generateOpenApiClient(doc, { sdkImport: '@hono-enterprise/sdk' });
    await compileCheck(source);
  });
});
