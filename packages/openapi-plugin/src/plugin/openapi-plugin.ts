import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { IPlugin, IPluginContext } from '@hono-enterprise/common';

import type { OpenApiGeneratorOptions } from '../generators/openapi-generator.ts';
import type { IOpenApiService } from '../interfaces/openapi-service.ts';
import { OpenApiService } from '../services/openapi-service.ts';
import { swaggerUiHtml } from '../ui/swagger-ui.ts';

/**
 * Options for the OpenAPI plugin.
 *
 * @since 0.1.0
 */
export interface OpenApiPluginOptions extends OpenApiGeneratorOptions {
  /**
   * Whether to serve the Swagger UI HTML page.
   *
   * @defaultValue true
   */
  readonly swagger?: boolean;

  /**
   * Path for the Swagger UI HTML page.
   *
   * @defaultValue '/docs'
   */
  readonly endpoint?: string;

  /**
   * Path for the JSON spec endpoint.
   *
   * @defaultValue '/openapi.json'
   */
  readonly specEndpoint?: string;
}

/**
 * Creates an OpenAPI plugin that auto-generates OpenAPI 3.1 documentation
 * from registered routes and serves it (with optional Swagger UI).
 *
 * The plugin:
 * - Registers an `IOpenApiService` under `CAPABILITIES.OPENAPI`
 * - Drains `CAPABILITIES.OPENAPI_SCHEMA` contributions at registration
 * - Serves the spec at `specEndpoint` (default `/openapi.json`)
 * - Serves Swagger UI at `endpoint` (default `/docs`) when `swagger !== false`
 *
 * @param options - Plugin options
 * @returns An `IPlugin` instance
 *
 * @example
 * ```typescript
 * app.register(OpenApiPlugin({
 *   title: 'My API',
 *   version: '1.0.0',
 *   endpoint: '/docs',
 *   specEndpoint: '/openapi.json',
 * }));
 * ```
 *
 * @since 0.1.0
 */
export function OpenApiPlugin(options: OpenApiPluginOptions = {}): IPlugin {
  const {
    title,
    version,
    description,
    servers,
    securitySchemes,
    swagger = true,
    endpoint = '/docs',
    specEndpoint = '/openapi.json',
  } = options;

  return {
    name: 'openapi-plugin',
    version: '0.1.0',
    provides: [CAPABILITIES.OPENAPI],
    priority: PLUGIN_PRIORITY.OPENAPI,

    register(ctx: IPluginContext): void {
      // Create the OpenAPI service
      const openApiService = new OpenApiService({
        app: ctx.app,
        title: title ?? 'API',
        version: version ?? '1.0.0',
        ...(description !== undefined ? { description } : {}),
        ...(servers !== undefined ? { servers } : {}),
        ...(securitySchemes !== undefined ? { securitySchemes } : {}),
        schemas: [], // Will be populated at onInit
      });

      // Register the service
      ctx.services.register<IOpenApiService>(CAPABILITIES.OPENAPI, openApiService);

      // Drain contributed schemas at onInit (after all plugins have registered)
      ctx.lifecycle.onInit(() => {
        const schemas = ctx.services.getAll(CAPABILITIES.OPENAPI_SCHEMA) as {
          name: string;
          schema: unknown;
        }[];
        // Add each contributed schema to the generator
        for (const { name, schema } of schemas) {
          openApiService.addSchema(name, schema);
        }
      });

      // Register the spec endpoint
      ctx.router.get(specEndpoint, (ctx) => {
        const spec = openApiService.getSpec();
        return ctx.response
          .status(200)
          .header('Content-Type', 'application/json')
          .json(spec);
      });

      // Register the Swagger UI endpoint
      if (swagger) {
        const uiHtml = swaggerUiHtml({
          specUrl: specEndpoint,
          title: `${title ?? 'API'} - Documentation`,
        });

        ctx.router.get(endpoint, (ctx) => {
          const result = ctx.response
            .status(200)
            .text(uiHtml);
          // Override content-type to HTML after text() sets it to text/plain
          ctx.response.header('Content-Type', 'text/html; charset=utf-8');
          return result;
        });
      }
    },
  };
}
