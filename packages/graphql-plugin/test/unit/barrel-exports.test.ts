/**
 * Tests for barrel exports — ensures all expected symbols are exported.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as graphqlPlugin from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports GraphqlPlugin', () => {
    expect(graphqlPlugin.GraphqlPlugin).toBeDefined();
    expect(typeof graphqlPlugin.GraphqlPlugin).toBe('function');
  });

  it('exports GraphqlService', () => {
    expect(graphqlPlugin.GraphqlService).toBeDefined();
  });

  it('exports GraphqlSchemaError', () => {
    expect(graphqlPlugin.GraphqlSchemaError).toBeDefined();
  });

  it('exports GraphqlRuntimeLoadError', () => {
    expect(graphqlPlugin.GraphqlRuntimeLoadError).toBeDefined();
  });

  it('exports adaptGraphqlModule', () => {
    expect(graphqlPlugin.adaptGraphqlModule).toBeDefined();
    expect(typeof graphqlPlugin.adaptGraphqlModule).toBe('function');
  });

  it('exports loadGraphqlModule', () => {
    expect(graphqlPlugin.loadGraphqlModule).toBeDefined();
    expect(typeof graphqlPlugin.loadGraphqlModule).toBe('function');
  });

  it('exports graphiqlHtml', () => {
    expect(graphqlPlugin.graphiqlHtml).toBeDefined();
    expect(typeof graphqlPlugin.graphiqlHtml).toBe('function');
  });

  it('exports createDepthLimitRule', () => {
    expect(graphqlPlugin.createDepthLimitRule).toBeDefined();
    expect(typeof graphqlPlugin.createDepthLimitRule).toBe('function');
  });

  it('exports expected types (compile-time check)', () => {
    // These are type-only exports, so we just verify the module loads
    expect(graphqlPlugin).toBeDefined();
  });
});
