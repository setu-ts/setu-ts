import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { generateOpenApiClient, OpenApiCodegenError } from '../../src/index.ts';
import type {
  SdkOpenApiDocument,
  SdkOpenApiRequestBody,
  SdkOpenApiSchema,
} from '../../src/index.ts';

const schema = {
  type: 'object',
  properties: { title: { type: 'string' }, file: { type: 'string', format: 'binary' } },
  required: ['title', 'file'],
};
const doc = (requestBody?: SdkOpenApiRequestBody): SdkOpenApiDocument => ({
  openapi: '3.1.0',
  paths: {
    '/uploads': {
      post: {
        operationId: 'upload',
        ...(requestBody === undefined ? {} : { requestBody }),
        responses: { '200': { description: 'OK' } },
      },
    },
  },
});

describe('codegen form bodies', () => {
  it('selects JSON independent of content order when all three media types exist', () => {
    const source = generateOpenApiClient(
      doc({
        required: true,
        content: {
          'multipart/form-data': { schema },
          'application/x-www-form-urlencoded': { schema },
          'application/json': { schema },
        },
      }),
    );
    expect(source).toContain('json: opts.body,');
    expect(source).not.toContain('multipart:');
  });
  it('emits multipart with Blob fields for required and optional bodies', () => {
    for (const required of [true, false]) {
      const source = generateOpenApiClient(
        doc({ required, content: { 'multipart/form-data': { schema } } }),
      );
      expect(source).toContain("'file': globalThis.Blob;");
      expect(source).toContain(
        required
          ? 'multipart: opts.body,'
          : '...(opts?.body === undefined ? {} : { multipart: opts.body }),',
      );
      expect(source).not.toContain('json:');
    }
  });
  it('refuses unsupported or empty body content with path and method', () => {
    for (const content of [
      { 'application/x-www-form-urlencoded': { schema } },
      { 'text/plain': { schema } },
      {},
    ]) {
      try {
        generateOpenApiClient(doc({ content }));
        expect.fail('must refuse a body the client would drop');
      } catch (error) {
        expect(error).toBeInstanceOf(OpenApiCodegenError);
        expect(error).toMatchObject({ path: '/uploads', method: 'post' });
        expect((error as Error).message).toContain(
          `request body media types ${Object.keys(content).join(', ')} are not supported: the generated method would drop the body`,
        );
      }
    }
  });
  it('keeps bodies without content and supported media without a schema bodiless', () => {
    for (const body of [undefined, {}, { content: { 'application/json': {} } }]) {
      const source = generateOpenApiClient(doc(body));
      expect(source).not.toContain('json:');
      expect(source).not.toContain('multipart:');
    }
  });
  it('refuses a multipart body that is not an object of form fields (review)', () => {
    const withComponents = (body: SdkOpenApiRequestBody): SdkOpenApiDocument => ({
      ...doc(body),
      components: {
        schemas: {
          Upload: schema,
          Text: { type: 'string' },
          Loop: { $ref: '#/components/schemas/Loop' },
        },
      },
    });
    for (const media of [
      {},
      { schema: { type: 'string' } },
      { schema: { $ref: '#/components/schemas/Text' } },
      { schema: { $ref: '#/components/schemas/Missing' } },
      { schema: { $ref: '#/components/schemas/Loop' } },
      { schema: { $ref: 'https://example.test/schema.json' } },
      // Properties without `type` render as `unknown`, which `multipart` refuses.
      { schema: { properties: { title: { type: 'string' } } } },
      // Composition keywords render before `type` (review): each would emit a
      // type `multipart?: object` does not accept.
      { schema: { type: 'object', anyOf: [{ type: 'string' }, { type: 'object' }] } },
      { schema: { type: 'object', oneOf: [{ type: 'string' }] } },
      { schema: { type: 'object', allOf: [{ type: 'string' }] } },
      { schema: { type: 'object', enum: ['a'] } },
      { schema: { type: 'object', const: 'a' } },
      { schema: { type: ['object', 'null'] } },
    ]) {
      try {
        generateOpenApiClient(
          withComponents({ required: true, content: { 'multipart/form-data': media } }),
        );
        expect.fail(`must refuse ${JSON.stringify(media)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(OpenApiCodegenError);
        expect(error).toMatchObject({ path: '/uploads', method: 'post' });
        expect((error as Error).message).toContain(
          'multipart/form-data request body schema is not an object of form fields',
        );
      }
    }
    // A reference to an object component is accepted.
    for (const media of [{ schema: { $ref: '#/components/schemas/Upload' } }]) {
      expect(
        generateOpenApiClient(
          withComponents({ required: true, content: { 'multipart/form-data': media } }),
        ),
      ).toContain('multipart: opts.body,');
    }
  });
  it('refuses a multipart field the encoder can never send, naming it (review)', () => {
    const components = {
      schemas: {
        Meta: { type: 'object', properties: { a: { type: 'string' } } },
        Tags: { type: 'array', items: { type: 'string' } },
      },
    };
    const body = (properties: Record<string, unknown>): SdkOpenApiDocument => ({
      ...doc({
        required: true,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties } as SdkOpenApiSchema,
          },
        },
      }),
      components,
    });
    for (const [field, properties] of [
      ['metadata', { metadata: { type: 'object' } }],
      ['meta', { meta: { $ref: '#/components/schemas/Meta' } }],
      ['rows', { rows: { type: 'array', items: { type: 'object' } } }],
      ['grid', { grid: { type: 'array', items: { $ref: '#/components/schemas/Tags' } } }],
      ['bad\nname', { 'bad\nname': { type: 'object' } }],
    ] as const) {
      try {
        generateOpenApiClient(body(properties));
        expect.fail(`must refuse ${field}`);
      } catch (error) {
        expect(error).toBeInstanceOf(OpenApiCodegenError);
        expect((error as Error).message).toContain(
          `field '${field.replace('\n', '')}' is not a flat form value`,
        );
      }
    }
    // Flat fields, arrays of them, enums, composed and untyped fields pass.
    expect(
      generateOpenApiClient(
        body({
          title: { type: 'string' },
          count: { type: 'integer' },
          file: { type: 'string', format: 'binary' },
          files: { type: 'array', items: { type: 'string', format: 'binary' } },
          tags: { $ref: '#/components/schemas/Tags' },
          kind: { enum: ['a', 'b'] },
          either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          anything: {},
        }),
      ),
    ).toContain('multipart: opts.body,');
  });
  it('type-checks the emitted client and a File caller under exact optional types', () => {
    const files = new Map<string, string>();
    for (const { required, query, blob } of [
      { required: true, query: false, blob: false },
      { required: false, query: false, blob: false },
      { required: false, query: true, blob: false },
      // A component named `Blob` must not capture the binary field's type
      // (review): unqualified, it emitted the circular `type Blob = Blob`.
      { required: true, query: false, blob: true },
    ]) {
      const path = resolve(`.tmp/m137c-generated-${required}-${query}-${blob}.ts`);
      const plain = doc({ required, content: { 'multipart/form-data': { schema } } });
      const base: SdkOpenApiDocument = blob
        ? {
            ...plain,
            components: {
              schemas: {
                Blob: { type: 'string', format: 'binary' },
                Attachment: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Blob' } },
                },
              },
            },
          }
        : plain;
      const source = generateOpenApiClient(
        query
          ? {
              ...base,
              paths: {
                '/uploads': {
                  post: {
                    ...base.paths['/uploads']!.post!,
                    parameters: [
                      { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
                    ],
                  },
                },
              },
            }
          : base,
      );
      const missingBodyCall = required
        ? ''
        : query
          ? "api.upload({ token: 'x' });"
          : 'api.upload();\napi.upload({});';
      files.set(
        path,
        `${source}\nimport { createClient } from '@setu-ts/sdk';\nconst api = createApi(createClient({ baseUrl: 'https://example.test' }));\napi.upload({ ${query ? "token: 'x', " : ''}body: { title: 'hello', file: new File(['hello'], 'hello.txt') } });\n${missingBodyCall}`,
      );
    }
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      paths: {
        '@setu-ts/sdk': [resolve('packages/sdk/src/index.ts')],
        '@setu-ts/common': [resolve('packages/common/src/index.ts')],
      },
    };
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...files.keys()],
      getScriptVersion: () => '0',
      getScriptSnapshot: (name) => {
        const text = files.get(name) ?? ts.sys.readFile(name);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => process.cwd(),
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
      readFile: (name) => files.get(name) ?? ts.sys.readFile(name),
      readDirectory: ts.sys.readDirectory,
    };
    const service = ts.createLanguageService(host);
    try {
      for (const path of files.keys()) {
        expect(service.getSyntacticDiagnostics(path)).toEqual([]);
        expect(
          service
            .getSemanticDiagnostics(path)
            .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
        ).toEqual([]);
      }
    } finally {
      service.dispose();
    }
  });
});
