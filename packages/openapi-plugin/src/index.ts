/**
 * OpenAPI plugin for Hono Enterprise.
 *
 * Auto-generates OpenAPI 3.1 documentation from registered routes and serves
 * it (with optional Swagger UI) over HTTP.
 *
 * @module
 */

// Plugin
export { OpenApiPlugin } from './plugin/openapi-plugin.ts';
export type { OpenApiPluginOptions } from './plugin/openapi-plugin.ts';

// Service
export { OpenApiService } from './services/openapi-service.ts';
export type { OpenApiServiceOptions } from './services/openapi-service.ts';
export type { IOpenApiService } from './interfaces/openapi-service.ts';

// Generator
export { OpenApiGenerator } from './generators/openapi-generator.ts';
export type {
  OpenApiDocument,
  OpenApiGeneratorOptions,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiRequestBody,
  OpenApiResponse,
} from './generators/openapi-generator.ts';

// Transformer
export { ZodToOpenApi, zodToOpenApi } from './transformers/zod-to-openapi.ts';
export type { OpenApiSchemaObject } from './transformers/zod-to-openapi.ts';

// UI
export { swaggerUiHtml } from './ui/swagger-ui.ts';
export type { SwaggerUiOptions } from './ui/swagger-ui.ts';
