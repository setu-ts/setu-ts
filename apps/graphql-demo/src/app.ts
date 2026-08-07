/**
 * Composes the demo application.
 *
 * Returned un-started so a caller decides the port — the interop run needs an
 * ephemeral one, and every run needs a process of its own so the APQ cache
 * starts cold. A warm cache is what turns the persisted-query check into a
 * test that passes without exercising anything.
 *
 * @module
 */

import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { CachePlugin } from '@setu-ts/cache-plugin';
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
import { createResolvers, typeDefs } from './schema.ts';

/**
 * Builds the demo application with every M51b feature enabled.
 *
 * @returns An un-started application; the caller supplies the port
 */
export function createDemoApp(): IKernelApplication {
  const { resolvers } = createResolvers();

  return createApplication({
    plugins: [
      RuntimePlugin(),
      // No `heartbeatMs`: the GraphQL route opts out of the shared sweep
      // anyway, but leaving it off keeps the demo's default composition honest.
      WebSocketPlugin(),
      // APQ persists the hash→document map here. Without a cache capability it
      // would fall back to a bounded in-process LRU.
      CachePlugin(),
      GraphqlPlugin({
        typeDefs,
        resolvers,
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

/** Reserves a free port by binding one and releasing it immediately. */
export function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}
