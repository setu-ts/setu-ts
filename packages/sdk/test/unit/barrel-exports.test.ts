import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

describe('@hono-enterprise/sdk barrel', () => {
  it('exports the runtime surface from Part A', () => {
    expect(typeof barrel.createClient).toBe('function');
    expect(typeof barrel.createDefaultClientTiming).toBe('function');
    expect(typeof barrel.createBearerAuthInterceptor).toBe('function');
    expect(typeof barrel.createApiKeyAuthInterceptor).toBe('function');
    expect(typeof barrel.HttpClientError).toBe('function');
    expect(typeof barrel.ClientCircuitOpenError).toBe('function');
    expect(typeof barrel.OpenApiCodegenError).toBe('function');
  });

  it('exports the codegen surface from Part B', () => {
    expect(typeof barrel.generateOpenApiClient).toBe('function');
    expect(typeof barrel.sanitizeIdentifier).toBe('function');
  });

  it('does not leak internal implementation classes', () => {
    for (const name of ['HttpClient', 'RateLimiter', 'CircuitBreaker', 'RetryStrategy']) {
      expect(Object.keys(barrel)).not.toContain(name);
    }
  });

  it('exports all expected symbols', () => {
    const expected = [
      'createClient',
      'createDefaultClientTiming',
      'createBearerAuthInterceptor',
      'createApiKeyAuthInterceptor',
      'HttpClientError',
      'ClientCircuitOpenError',
      'OpenApiCodegenError',
      'generateOpenApiClient',
      'sanitizeIdentifier',
    ];
    for (const name of expected) {
      expect(Object.keys(barrel)).toContain(name);
    }
  });
});
