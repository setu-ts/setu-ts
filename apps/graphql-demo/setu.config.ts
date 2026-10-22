import { CachePlugin } from '@setu-ts/cache-plugin';
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { createResolvers } from './src/modules/books/books.resolvers.ts';
import { typeDefs } from './src/modules/books/books.schema.ts';

/**
 * Builds the demo with every GraphQL transport and feature enabled, without starting it.
 *
 * Each call builds fresh resolver state and an empty persisted-query cache, so
 * the interop suite's persisted-query check starts cold.
 */
export function createApp(): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      WebSocketPlugin(),
      // Holds the persisted-query map; without it APQ uses a bounded in-process cache.
      CachePlugin(),
      GraphqlPlugin({
        typeDefs,
        resolvers: createResolvers(),
        subscriptions: {
          websocket: { connectionInitWaitMs: 5000 },
          sse: { heartbeatMs: 10_000 },
        },
        apq: { ttlSeconds: 300 },
        maxBatchSize: 10,
        graphiql: true,
      }),
    ],
  });
}
