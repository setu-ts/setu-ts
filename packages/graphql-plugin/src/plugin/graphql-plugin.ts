/**
 * GraphQL plugin — the main plugin factory.
 *
 * @module
 */

import type {
  ICacheStore,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  IWebSocketService,
} from '@hono-enterprise/common';
import { CAPABILITIES as CAP } from '@hono-enterprise/common';
import type { GraphqlPluginOptions } from '../interfaces/options.ts';
import { adaptGraphqlModule, loadGraphqlModule } from '../runtime/graphql-loader.ts';
import { buildSchema } from '../schema/build-schema.ts';
import { GraphqlService } from '../services/graphql-service.ts';
import { createGraphqlHandler } from '../http/graphql-handler.ts';
import { GRAPHQL_TRANSPORT_WS } from '../transports/ws/ws-protocol.ts';
import { ApqResolver } from '../apq/apq-resolver.ts';

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
  const buildContext = options.buildContext;
  const rootValue = options.rootValue;
  const subscriptions = options.subscriptions;
  const apq = options.apq;
  const maxBatchSize = options.maxBatchSize ?? 0;

  let graphqlService: GraphqlService | null = null;
  let wsService: IWebSocketService | null = null;
  let wsAvailable = false;
  let apqResolver: ApqResolver | null = null;

  return {
    name: 'graphql-plugin',
    version: '0.1.0',
    provides: [CAP.GRAPHQL],
    optionalDependencies: ['logger', CAP.HEALTH, CAP.WEBSOCKET, CAP.CACHE, CAP.RUNTIME],

    async register(ctx: IPluginContext): Promise<void> {
      const logger = ctx.logger;

      // C5 — APQ RUNTIME guard: when APQ is configured, CAPABILITIES.RUNTIME
      // must be present (needed for subtle crypto hashing).
      if (apq !== undefined) {
        if (!ctx.services.has(CAP.RUNTIME)) {
          throw new Error(
            'APQ requires CAPABILITIES.RUNTIME for hash verification. ' +
              'Register the RuntimePlugin or disable APQ.',
          );
        }
      }

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
      const handlerLogger = ctx.logger ? createHandlerLogger(ctx.logger) : undefined;
      graphqlService = new GraphqlService(runtime, schema, {
        endpoint: path,
        documentCacheSize,
        ...(options.validationRules && { validationRules: options.validationRules }),
        maxDepth,
        introspection,
        maskInternalErrors,
        formatError,
        ...(buildContext && { buildContext }),
        rootValue,
        ...(handlerLogger && { logger: handlerLogger }),
        serviceRegistry: ctx.services,
      });

      // Register service
      ctx.services.register(CAP.GRAPHQL, graphqlService);

      // B1 — Instantiate ApqResolver when APQ is configured
      if (apq !== undefined) {
        const runtimeServices = ctx.services.get<IRuntimeServices>(CAP.RUNTIME);
        const cacheStore = ctx.services.has(CAP.CACHE)
          ? ctx.services.get<ICacheStore>(CAP.CACHE)
          : null;
        const apqOpts: { ttlSeconds?: number; maxEntries?: number } = {};
        if (apq.ttlSeconds !== undefined) apqOpts.ttlSeconds = apq.ttlSeconds;
        if (apq.maxEntries !== undefined) apqOpts.maxEntries = apq.maxEntries;
        apqResolver = new ApqResolver(cacheStore, runtimeServices.subtle, apqOpts);
      }

      // Register HTTP routes
      const { post, get } = createGraphqlHandler(graphqlService, path, {
        graphiql,
        maxBatchSize,
        apqResolver,
        ...(handlerLogger && { logger: handlerLogger }),
      });

      ctx.router.post(path, post);
      ctx.router.get(path, get);

      // Register subscription transports (opt-in)
      if (subscriptions) {
        // WebSocket transport (optional capability)
        if (subscriptions.websocket !== false) {
          const wsOpt = subscriptions.websocket;
          if (ctx.services.has(CAP.WEBSOCKET)) {
            wsService = ctx.services.get<IWebSocketService>(CAP.WEBSOCKET);
            if (wsService?.available) {
              wsAvailable = true;
              const { createWsHandlers } = await import('../transports/ws/graphql-ws-handler.ts');
              const wsPath = (wsOpt as { path?: string })?.path ?? `${path}/ws`;
              // C6: thread apqResolver into WS handlers so hash-only subscribe
              // returns PERSISTED_QUERY_NOT_FOUND instead of a parse error.
              const wsHandlers = createWsHandlers(
                graphqlService,
                wsOpt ?? {},
                ctx.services,
                apqResolver,
              );
              wsService.route(wsPath, wsHandlers, {
                protocols: [GRAPHQL_TRANSPORT_WS],
                heartbeat: false,
              });
              logger?.info(`GraphQL WS subscriptions registered at ${wsPath}`);
            } else {
              logger?.warn('GraphQL WS subscriptions skipped: WebSocket not available');
            }
          } else {
            logger?.warn('GraphQL WS subscriptions skipped: CAPABILITIES.WEBSOCKET absent');
          }
        }

        // SSE transport (no capability needed)
        if (subscriptions.sse !== false) {
          const sseOpt = subscriptions.sse;
          const { createSseHandler } = await import('../transports/sse/graphql-sse-handler.ts');
          const ssePath = (sseOpt as { path?: string })?.path ?? `${path}/stream`;
          const sseHeartbeat = (sseOpt as { heartbeatMs?: number })?.heartbeatMs ?? 0;
          const sseHandler = createSseHandler(
            graphqlService,
            sseHeartbeat,
            apqResolver,
          );
          ctx.router.post(ssePath, sseHandler.post);
          ctx.router.get(ssePath, sseHandler.get);
          logger?.info(`GraphQL SSE subscriptions registered at ${ssePath}`);
        }
      }

      // Register health indicator
      ctx.health.register('graphql', async () => {
        return await Promise.resolve({
          status: 'up',
          data: {
            endpoint: path,
            cachedDocuments: graphqlService!.cachedDocumentCount,
            subscriptions: subscriptions
              ? {
                websocket: wsAvailable,
                sse: subscriptions.sse !== false,
              }
              : undefined,
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
