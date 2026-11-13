/**
 * Tests for barrel exports.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import * as openapiPlugin from '../../src/index.ts';
import type {
  IOpenApiService,
  OpenApiSchemaObject,
  SchemaNodeHook,
  OpenApiExternalDocs,
  OpenApiTag,
} from '../../src/index.ts';
import type { IOpenApiService as CommonOpenApiService } from '@setu-ts/common';

describe('Barrel exports', () => {
  it('exports document metadata contracts and keeps their implementation internal', () => {
    const error = new openapiPlugin.OpenApiDocumentOptionsError(
      'duplicate-tag',
      'duplicate users tag',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('OpenApiDocumentOptionsError');
    expect(error.reason).toBe('duplicate-tag');
    expect(error.message).toBe('duplicate users tag');
    const docs: OpenApiExternalDocs = { url: '/guide' };
    const tag: OpenApiTag = { name: 'users', externalDocs: docs };
    expect(tag.externalDocs).toBe(docs);
    expect(openapiPlugin).not.toHaveProperty('validateDocumentMetadata');
    expect(openapiPlugin).not.toHaveProperty('buildDocumentMetadata');
  });
  it('exports OperationIdError with a reason and keeps allocation helpers internal', () => {
    const error = new openapiPlugin.OperationIdError('duplicate', 'duplicate id');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('OperationIdError');
    expect(error.reason).toBe('duplicate');
    expect(error.message).toBe('duplicate id');
    expect(openapiPlugin).not.toHaveProperty('claimDeclaredOperationIds');
    expect(openapiPlugin).not.toHaveProperty('isRouteExcluded');
  });
  it('should export OpenApiPlugin', () => {
    expect(openapiPlugin.OpenApiPlugin).toBeDefined();
    expect(typeof openapiPlugin.OpenApiPlugin).toBe('function');
  });

  it('should export OpenApiService', () => {
    expect(openapiPlugin.OpenApiService).toBeDefined();
    expect(typeof openapiPlugin.OpenApiService).toBe('function');
  });

  it('should export OpenApiGenerator', () => {
    expect(openapiPlugin.OpenApiGenerator).toBeDefined();
    expect(typeof openapiPlugin.OpenApiGenerator).toBe('function');
  });

  it('should export ZodToOpenApi', () => {
    expect(openapiPlugin.ZodToOpenApi).toBeDefined();
    expect(typeof openapiPlugin.ZodToOpenApi).toBe('function');
  });

  it('should export zodToOpenApi', () => {
    expect(openapiPlugin.zodToOpenApi).toBeDefined();
    expect(typeof openapiPlugin.zodToOpenApi).toBe('function');
  });

  it('should export swaggerUiHtml', () => {
    expect(openapiPlugin.swaggerUiHtml).toBeDefined();
    expect(typeof openapiPlugin.swaggerUiHtml).toBe('function');
  });

  it('should export IOpenApiService type', () => {
    const service: IOpenApiService = { getSpec: () => ({ paths: {} }), addSchema: () => {} };
    const shared: CommonOpenApiService = service;
    expect(shared.getSpec()).toEqual({ paths: {} });
  });
  it('exports the SchemaNodeHook type (declared against the barrel)', () => {
    // Compile-time. This export was previously pinned by NOTHING but the
    // README exports-table drift check: removing it left the whole suite and
    // `deno check` green (M56 defect class).
    const hook: SchemaNodeHook = (schema: unknown): OpenApiSchemaObject | undefined =>
      schema === undefined ? undefined : { type: 'object' };

    expect(hook({})).toEqual({ type: 'object' });
    expect(hook(undefined)).toBeUndefined();
  });
});
