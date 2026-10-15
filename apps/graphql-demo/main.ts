/* eslint-disable no-console -- an example app's entry point prints its */
// own endpoints; this is a runnable demo, not library code.
/**
 * Starts the demo server for interactive use.
 *
 * ```
 * pnpm --dir apps/graphql-demo run start          # http://localhost:4000/graphql for GraphiQL
 * pnpm --dir apps/graphql-demo run start 4100     # or pick a port
 * ```
 *
 * @module
 */

import { createDemoApp } from './src/app.ts';

const port = Number(process.argv[2] ?? 4000);
const app = createDemoApp();
await app.start({ port });

console.log(`
  GraphQL demo on http://localhost:${port}

    GraphiQL     http://localhost:${port}/graphql        (open in a browser)
    HTTP         POST http://localhost:${port}/graphql   queries, mutations, batching, APQ
    WebSocket    ws://localhost:${port}/graphql/ws       graphql-transport-ws
    SSE          POST http://localhost:${port}/graphql/stream
`);
