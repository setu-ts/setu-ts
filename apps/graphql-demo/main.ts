// deno-lint-ignore-file no-console -- an example app's entry point prints its
// own endpoints; this is a runnable demo, not library code.
/**
 * Starts the demo server for interactive use.
 *
 * ```
 * deno task start          # http://localhost:4000/graphql for GraphiQL
 * deno task start 4100     # or pick a port
 * ```
 *
 * @module
 */

import { createDemoApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 4000);
const app = createDemoApp();
await app.start({ port });

console.log(`
  GraphQL demo on http://localhost:${port}

    GraphiQL     http://localhost:${port}/graphql        (open in a browser)
    HTTP         POST http://localhost:${port}/graphql   queries, mutations, batching, APQ
    WebSocket    ws://localhost:${port}/graphql/ws       graphql-transport-ws
    SSE          POST http://localhost:${port}/graphql/stream
`);
