/**
 * GraphQL plugin — the main plugin factory.
 *
 * @module
 */

import type { IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES as CAP } from '@hono-enterprise/common';
import type { GraphqlPluginOptions } from '../interfaces/options.ts';
import { adaptGraphqlModule, loadGraphqlModule } from '../runtime/graphql-loader.ts';
import { buildSchema } from '../schema/build-schema.ts';
import { GraphqlService } from '../services/graphql-service.ts';
import { createGraphqlHandler } from '../http/graphql-handler.ts';

/**
 * Create a handler logger wrapper from a plugin context logger.
 * This is extracted as a named function for testability.
 * @internal - exported for testing only
 */
export function createHandlerLogger(
  logger: NonNullable<IPluginContext['logger']>,
): { info: (msg: string) => void; error: (msg: string, err?: unknown) => void } {
  return {
    info: (msg: string) => logger.info(msg),
    error: (msg: string, err?: unknown) => logger.error(msg, err as Record<string, unknown>),
  };
}

/**
 * Create a GraphQL plugin.
 *
 * @param options - The plugin options
 * @returns A GraphQL plugin
 */
export function GraphqlPlugin(options: GraphqlPluginOptions): IPlugin {
  const path = options.path ?? '/graphql';
  const graphiql = options.graphiql ?? true;
  const introspection = options.introspection ?? true;
  const maxDepth = options.maxDepth ?? 10;
  const maskInternalErrors = options.maskInternalErrors ?? true;
  const documentCacheSize = options.documentCacheSize ?? 1000;
  const formatError = options.formatError ?? ((_e: unknown) => _e);
  const buildContext = options.buildContext ?? ((_i: unknown) => ({}));
  const rootValue = options.rootValue;

  let graphqlService: GraphqlService | null = null;

  return {
    name: 'graphql-plugin',
    version: '0.1.0',
    provides: [CAP.GRAPHQL],
    optionalDependencies: ['logger', CAP.HEALTH],

    async register(ctx: IPluginContext): Promise<void> {
      const logger = ctx.logger;

      // Load graphql runtime
      const runtime = options.graphqlModule
        ? adaptGraphqlModule(options.graphqlModule)
        : await loadGraphqlModule();

      // Build schema
      let schema;
      try {
        schema = buildSchema(options, runtime);
      } catch (error) {
        logger?.error('Failed to build GraphQL schema', error as Record<string, unknown>);
        throw error;
      }

      // Attach resolvers if schema-first
      if ('typeDefs' in options && options.typeDefs && options.resolvers) {
        try {
          const { attachResolvers } = await import('../schema/attach-resolvers.ts');
          attachResolvers(schema, options.resolvers);
        } catch (error) {
          logger?.error('Failed to attach resolvers', error as Record<string, unknown>);
          throw error;
        }
      }

      // Create service
      graphqlService = new GraphqlService(runtime, schema, {
        endpoint: path,
        documentCacheSize,
        ...(options.validationRules && { validationRules: options.validationRules }),
        maxDepth,
        introspection,
        maskInternalErrors,
        formatError,
        buildContext,
        rootValue,
      });

      // Register service
      ctx.services.register(CAP.GRAPHQL, graphqlService);

      // Register routes - handle optional logger with exactOptionalPropertyTypes
      const handlerLogger = ctx.logger ? createHandlerLogger(ctx.logger) : undefined;
      const { post, get } = createGraphqlHandler(graphqlService, path, {
        graphiql,
        ...(handlerLogger && { logger: handlerLogger }),
      });

      ctx.router.post(path, post);
      ctx.router.get(path, get);

      // Register health indicator
      ctx.health.register('graphql', async () => {
        return await Promise.resolve({
          status: 'up',
          data: {
            endpoint: path,
            cachedDocuments: graphqlService!.cachedDocumentCount,
          },
        });
      });

      // A2: Register onClose to clear cache on shutdown (if lifecycle is available)
      if (ctx.lifecycle) {
        ctx.lifecycle.onClose(() => {
          graphqlService?.clearCache();
        });
      }

      logger?.info(`GraphQL plugin registered at ${path}`);
    },
  };
}
