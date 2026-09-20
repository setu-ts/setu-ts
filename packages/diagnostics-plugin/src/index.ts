/**
 * @module
 *
 * DiagnosticsPlugin — the authenticated local diagnostics connector (M98b).
 *
 * Connects a native devtool client to M98a's minimized diagnostic snapshots
 * and events over a separate, runtime-owned authenticated IPv4 loopback HTTP
 * listener. The first implementation supports Deno and bounded polling. It
 * has no browser-facing UI, no application-data reads, and no
 * application-control commands, and authentication stays independent of any
 * devtool subscription.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */

export { DiagnosticsPlugin } from './plugin/diagnostics-plugin.ts';
export type { DiagnosticsPluginOptions, IDiagnosticsPlugin } from './interfaces/index.ts';
export { createDiagnosticsClient } from './client/client.ts';
export type { DiagnosticsClientOptions, IDiagnosticsClient } from './interfaces/index.ts';
