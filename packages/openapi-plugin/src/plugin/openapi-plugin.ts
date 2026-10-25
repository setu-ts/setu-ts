import { CAPABILITIES, OptionalDependencyUnavailableError, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import {
  claimDeclaredOperationIds,
  DEFAULT_EXCLUDED_OWNERS,
  isRouteExcluded,
} from '../generators/declared-operation-ids.ts';

import type { OpenApiGeneratorOptions } from '../generators/openapi-generator.ts';
import type { IOpenApiService } from '../interfaces/openapi-service.ts';
import { OpenApiService } from '../services/openapi-service.ts';
import { resolveSwaggerAssets, SWAGGER_ASSETS, swaggerUiHtml } from '../ui/swagger-ui.ts';
import type { SwaggerOptions } from '../ui/swagger-ui.ts';
import { VERSION } from '../version.ts';

/**
 * Options for the OpenAPI plugin.
 *
 * @since 0.1.0
 */
export interface OpenApiPluginOptions extends OpenApiGeneratorOptions {
  /**
   * Whether to serve Swagger UI; options select self-hosted (default), pinned
   * CDN, or custom-base assets. Self-hosting requires swagger-ui-dist and fs.
   *
   * @defaultValue true
   */
  readonly swagger?: boolean | SwaggerOptions;

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
 * @throws {TypeError} If Swagger asset options are invalid
 * @throws {OptionalDependencyUnavailableError} At registration if self-hosting cannot load swagger-ui-dist
 * @throws {OperationIdError} At bootstrap if an included declared operation id is blank or duplicated
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
    deriveSecurity,
    excludeOwners,
    deriveRequestSchemas,
    deriveResponseStatus,
    exclude,
    swagger = true,
    endpoint = '/docs',
    specEndpoint = '/openapi.json',
  } = options;
  const assets = resolveSwaggerAssets(swagger);
  const assetBase = endpoint.replace(/\/+$/, '');

  // The documentation endpoints are not part of the API being documented, so
  // they are always excluded — a spec that lists `/openapi.json` and `/docs`
  // as operations describes its own delivery mechanism, and those entries flow
  // into every generated client. Caller exclusions are added on top.
  const excludedPaths = [
    specEndpoint,
    ...(swagger ? [endpoint] : []),
    // Asset routes exist only when self-hosting; in the external modes an
    // application route at the same path is the application's own.
    ...(swagger && assets === 'self'
      ? SWAGGER_ASSETS.map(({ file }) => `${assetBase}/${file}`)
      : []),
    ...(exclude ?? []),
  ];

  return {
    name: 'openapi-plugin',
    version: VERSION,
    provides: [CAPABILITIES.OPENAPI],
    priority: PLUGIN_PRIORITY.OPENAPI,

    async register(ctx: IPluginContext): Promise<void> {
      // A security requirement may only name a scheme the document declares.
      // Emitting one that does not produces a document that is invalid per the
      // OpenAPI specification: Swagger UI shows a lock on every operation with
      // no Authorize button to satisfy it, and strict validators and client
      // generators reject it outright. Nothing downstream can detect this —
      // the spec endpoint still answers 200 — so it is refused here, with the
      // offending name, rather than shipped as a broken document.
      const declaredSchemes = Object.keys(securitySchemes ?? {});
      const requiredSchemes = [
        ...(security ?? []).flatMap((requirement) => Object.keys(requirement)),
        // `deriveSecurity` names a scheme the same way, so it is subject to the
        // same check — an undeclared name there produces the identical invalid
        // document, on every guarded route rather than document-wide.
        ...(deriveSecurity !== undefined ? [deriveSecurity.scheme] : []),
      ];
      for (const schemeName of requiredSchemes) {
        if (!declaredSchemes.includes(schemeName)) {
          throw new Error(
            `OpenApiPlugin: security requires the scheme '${schemeName}', which is not declared ` +
              `in securitySchemes. Declared: ${
                declaredSchemes.length > 0 ? declaredSchemes.join(', ') : '(none)'
              }.`,
          );
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
        ...(deriveSecurity !== undefined ? { deriveSecurity } : {}),
        ...(excludeOwners !== undefined ? { excludeOwners } : {}),
        ...(deriveRequestSchemas !== undefined ? { deriveRequestSchemas } : {}),
        ...(deriveResponseStatus !== undefined ? { deriveResponseStatus } : {}),
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
        return ctx.response.status(200).header('Content-Type', 'application/json').json(spec);
      });

      // Register the Swagger UI endpoint
      if (swagger) {
        if (assets === 'self') {
          const fs = ctx.runtime.fs;
          if (fs === undefined) {
            throw new Error(
              "OpenApiPlugin self-hosted Swagger requires runtime.fs. Choose swagger: { assets: 'cdn' } or swagger: { assets: { baseUrl: '/assets' } }.",
            );
          }
          let directory: string;
          try {
            const mod = await import('swagger-ui-dist/absolute-path.js');
            directory = mod.default();
          } catch (cause) {
            const error = new OptionalDependencyUnavailableError('swagger-ui-dist', {
              requiredBy: '@setu-ts/openapi-plugin',
              cause,
            });
            error.message += " Install swagger-ui-dist, or choose swagger: { assets: 'cdn' }.";
            throw error;
          }
          for (const asset of SWAGGER_ASSETS) {
            const bytes = await fs.readFile(`${directory}/${asset.file}`);
            ctx.router.get(`${assetBase}/${asset.file}`, (ctx) =>
              ctx.response
                .status(200)
                .header('Content-Type', asset.contentType)
                .header('Cache-Control', 'public, max-age=3600')
                .send(bytes),
            );
          }
        }
        const uiHtml = swaggerUiHtml({
          specUrl: specEndpoint,
          title: `${title ?? 'API'} - Documentation`,
          assets,
          endpoint,
        });

        ctx.router.get(endpoint, (ctx) => {
          const result = ctx.response.status(200).text(uiHtml);
          // Override content-type to HTML after text() sets it to text/plain
          ctx.response.header('Content-Type', 'text/html; charset=utf-8');
          return result;
        });
      }

      const excludedPathSet = new Set(excludedPaths);
      const excludedOwnerSet = new Set(excludeOwners ?? DEFAULT_EXCLUDED_OWNERS);
      ctx.lifecycle.onBootstrap(() => {
        claimDeclaredOperationIds(ctx.router.listRoutes(), (route) =>
          isRouteExcluded(route, excludedPathSet, excludedOwnerSet),
        );
      });
    },
  };
}
