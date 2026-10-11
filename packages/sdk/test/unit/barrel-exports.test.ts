import { describe, expect, it } from 'vitest';
import * as barrel from '../../src/index.ts';

describe('@setu-ts/sdk barrel', () => {
  it('exports exactly the documented runtime surface', () => {
    const actual = Object.keys(barrel).sort();
    const expected = [
      'createClient',
      'createDefaultClientTiming',
      'createBearerAuthInterceptor',
      'createApiKeyAuthInterceptor',
      'HttpClientError',
      'ClientCircuitOpenError',
      'OpenApiCodegenError',
      'generateOpenApiClient',
      'createSseClient',
      'createRealtimeClient',
      'createObservedFetch',
      'createTraceContextInterceptor',
    ].sort();
    expect(actual).toEqual(expected);
  });

  it('does not leak internal implementation classes', () => {
    for (
      const name of [
        'HttpClient',
        'RateLimiter',
        'CircuitBreaker',
        'RetryStrategy',
        'OutboundHttpCollector',
        'createDefaultFetch',
        'OUTBOUND_HTTP_DIAGNOSTICS_TOKEN',
      ]
    ) {
      expect(Object.keys(barrel)).not.toContain(name);
    }
  });
});
