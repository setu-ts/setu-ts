import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { generateOpenApiClient, OpenApiCodegenError } from '../../src/index.ts';
import type { SdkOpenApiDocument, SdkOpenApiRequestBody } from '../../src/index.ts';

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
      expect(source).toContain("'file': Blob;");
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
    for (const body of [
      undefined,
      {},
      { content: { 'application/json': {} } },
      { content: { 'multipart/form-data': {} } },
    ]) {
      const source = generateOpenApiClient(doc(body));
      expect(source).not.toContain('json:');
      expect(source).not.toContain('multipart:');
    }
  });
  it('type-checks the emitted client and a File caller under exact optional types', () => {
    const files = new Map<string, string>();
    for (const { required, query } of [
      { required: true, query: false },
      { required: false, query: false },
      { required: false, query: true },
    ]) {
      const path = resolve(`.tmp/m137c-generated-${required}-${query}.ts`);
      const base = doc({ required, content: { 'multipart/form-data': { schema } } });
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
