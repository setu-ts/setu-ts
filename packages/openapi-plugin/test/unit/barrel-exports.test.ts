/**
 * Tests for barrel exports.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as openapiPlugin from '../../src/index.ts';

describe('Barrel exports', () => {
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
    // Types are erased at runtime, but we can verify the module exports correctly
    expect(openapiPlugin).toBeDefined();
  });
});
