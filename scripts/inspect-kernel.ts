#!/usr/bin/env -S deno run --allow-read --allow-env
// deno-lint-ignore-file no-console -- console output is the script's purpose (AI_GUIDELINES §11.6)
/**
 * Runnable public consumer for kernel diagnostics (M98a).
 *
 * Creates a small application with explicit diagnostic label allowlists,
 * starts it WITHOUT a port, injects a request, and prints only the public
 * DTOs — `DiagnosticsSnapshot` and `DiagnosticsBatch` — exactly as a real
 * consumer reads them through `IApplication.diagnostics`. It is the
 * in-repository proof that the read contracts work without decorators, DI,
 * or a network listener; M98b's connector consumes the same surface.
 *
 * The script deliberately uses PUBLIC interfaces only: no private kernel
 * imports, no application configuration, no secret capture.
 *
 * Usage:
 *   deno run --allow-read --allow-env scripts/inspect-kernel.ts
 *
 * @module
 */

import { CAPABILITIES } from '@setu-ts/common';
import type { DiagnosticsBatch, DiagnosticsSnapshot } from '@setu-ts/common';
import { createApplication } from '../packages/kernel/src/index.ts';
import { RuntimePlugin } from '../packages/runtime/src/index.ts';

/**
 * Builds the demonstration application: two labeled plugins, one capability
 * edge, one labeled route, one labeled global middleware stage, and one
 * route middleware stage that is NOT allowlisted (projected as id + position
 * only — function names are never consulted).
 *
 * @returns The composed application
 */
function buildApp() {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      {
        name: 'logging',
        version: '1.0.0',
        register(ctx) {
          ctx.middleware.add((_ctx, next) => next(), { name: 'request-log', priority: 20 });
        },
      },
      {
        name: 'catalog',
        version: '1.0.0',
        provides: ['catalog-items'],
        register(ctx) {
          ctx.services.register('catalog-items', { items: [] });
          ctx.router.get('/items', {
            handler: (ctx) => ctx.response.json({ items: [] }),
            middleware: [(_ctx, next) => next()],
          });
        },
      },
    ],
    // The disclosure decision, made explicit: these exact names may leave
    // the process. Everything unlisted is projected as opaque ids.
    diagnostics: {
      labels: {
        plugins: ['catalog'],
        capabilities: ['catalog-items', CAPABILITIES.RUNTIME],
        routes: ['/items'],
        middleware: ['request-log'],
      },
    },
  });
}

const app = buildApp();
await app.start(); // no port: no socket is ever bound

// Drive one request through the application so the event ring has content.
const response = await app.inject({ method: 'GET', url: '/items' });
console.log(`injected GET /items -> ${response.statusCode}`);

const source = app.diagnostics;
if (source === undefined) {
  console.error('diagnostics were not enabled — this is a bug in the script');
  Deno.exit(1);
}

const snapshot: DiagnosticsSnapshot = source.snapshot();
const batch: DiagnosticsBatch = source.read(0, 128);

// ONLY the public DTOs are emitted — never a live service, route definition,
// or plugin object.
console.log(JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify(batch, null, 2));

await app.stop();
