/**
 * @module
 *
 * `@hono-enterprise/sdk` — Portable, zero-npm-dependency client SDK for
 * consuming Hono Enterprise APIs.
 *
 * Exports the runtime client surface: interfaces, factories, error classes,
 * re-exported common policy types, and `createDefaultClientTiming`.
 *
 * Codegen exports (`generateOpenApiClient`, `SdkOpenApi*`, `OpenApiCodegenError`)
 * will land in Part B.
 */

// Factory
export { createClient } from './sdk.ts';

// Interfaces and types
export type {
  ClientOptions,
  ClientRateLimitPolicy,
  ClientRequest,
  ClientRequestContext,
  ClientRequestInterceptor,
  ClientResponse,
  ClientResponseInterceptor,
  IClientTiming,
  IHttpClient,
} from './http/contracts.ts';

// Re-exported common types
export type { BackoffStrategy, CircuitBreakerPolicy, RetryPolicy } from './http/contracts.ts';

// Timing
export { createDefaultClientTiming } from './http/timing.ts';

// Auth interceptors
export {
  createApiKeyAuthInterceptor,
  createBearerAuthInterceptor,
} from './auth/auth-interceptor.ts';

// Errors
export { ClientCircuitOpenError, HttpClientError, OpenApiCodegenError } from './errors.ts';

// Codegen
export { generateOpenApiClient, sanitizeIdentifier } from './codegen/openapi-codegen.ts';
export type { OpenApiCodegenOptions } from './codegen/openapi-codegen.ts';
export type {
  SdkOpenApiDocument,
  SdkOpenApiOperation,
  SdkOpenApiParameter,
  SdkOpenApiPathItem,
  SdkOpenApiRequestBody,
  SdkOpenApiResponse,
  SdkOpenApiSchema,
} from './codegen/openapi-types.ts';
