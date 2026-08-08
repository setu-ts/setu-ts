import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';

import type { OpenApiGeneratorOptions } from '../generators/openapi-generator.ts';
import type { IOpenApiService } from '../interfaces/openapi-service.ts';
import { OpenApiService } from '../services/openapi-service.ts';
import { swaggerUiHtml } from '../ui/swagger-ui.ts';
import denoJson from '../../deno.json' with { type: 'json' };

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
 * - Omits its own two endpoints from the document, plus anything named in
 *   {@linkcode OpenApiGeneratorOptions.exclude}
 *
 * Declaring `securitySchemes` is what gives Swagger UI its **Authorize**
 * button. Pair it with `security` to state that operations require
 * authentication by default; an individual route opts out with
 * `schema: { security: [] }`.
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
 *   securitySchemes: {
 *     bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
 *   },
 *   security: [{ bearerAuth: [] }],
 *   exclude: ['/health', '/live', '/ready', '/metrics'],
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
    security,
    exclude,
    swagger = true,
    endpoint = '/docs',
    specEndpoint = '/openapi.json',
  } = options;

  // The documentation endpoints are not part of the API being documented, so
  // they are always excluded — a spec that lists `/openapi.json` and `/docs`
  // as operations describes its own delivery mechanism, and those entries flow
  // into every generated client. Caller exclusions are added on top.
  const excludedPaths = [
    specEndpoint,
    ...(swagger ? [endpoint] : []),
    ...(exclude ?? []),
  ];

  return {
    name: 'openapi-plugin',
    version: denoJson.version,
    provides: [CAPABILITIES.OPENAPI],
    priority: PLUGIN_PRIORITY.OPENAPI,

    register(ctx: IPluginContext): void {
      // A security requirement may only name a scheme the document declares.
      // Emitting one that does not produces a document that is invalid per the
      // OpenAPI specification: Swagger UI shows a lock on every operation with
      // no Authorize button to satisfy it, and strict validators and client
      // generators reject it outright. Nothing downstream can detect this —
      // the spec endpoint still answers 200 — so it is refused here, with the
      // offending name, rather than shipped as a broken document.
      const declaredSchemes = Object.keys(securitySchemes ?? {});
      for (const requirement of security ?? []) {
        for (const schemeName of Object.keys(requirement)) {
          if (!declaredSchemes.includes(schemeName)) {
            throw new Error(
              `OpenApiPlugin: security requires the scheme '${schemeName}', which is not declared ` +
                `in securitySchemes. Declared: ${
                  declaredSchemes.length > 0 ? declaredSchemes.join(', ') : '(none)'
                }.`,
            );
          }
        }
      }

      // Create the OpenAPI service
      const openApiService = new OpenApiService({
        app: ctx.app,
        title: title ?? 'API',
        version: version ?? '1.0.0',
        ...(description !== undefined ? { description } : {}),
        ...(servers !== undefined ? { servers } : {}),
        ...(securitySchemes !== undefined ? { securitySchemes } : {}),
        ...(security !== undefined ? { security } : {}),
        exclude: excludedPaths,
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
