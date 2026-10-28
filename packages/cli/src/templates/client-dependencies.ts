/**
 * The client libraries a selected transport needs installed in the project.
 *
 * Every broker, queue and RPC client is an OPTIONAL peer of the plugin that
 * loads it, and a package manager never installs an optional peer for the
 * consumer — so a project scaffolded with `--broker redis` failed at its first
 * boot, at the plugin's lazy import of `ioredis`. The selected arm adds its
 * client to the project itself: a compatible range in `package.json`, an `npm:`
 * entry in a Deno import map. The ranges follow the plugins' peer ranges;
 * OpenTelemetry is narrowed to its compatible API and SDK lines. A test holds
 * the other entries equal to the framework's dependency table and pins the
 * OpenTelemetry compatibility bounds so neither can drift.
 *
 * @module
 */

import type { ResolvedHost } from './project-files.ts';

/** Each client package and its compatible install range. */
export const CLIENT_RANGES: Readonly<Record<string, string>> = {
  '@aws-sdk/client-sqs': '^3',
  '@azure/service-bus': '^7',
  '@bufbuild/protobuf': '^2.7.0',
  '@connectrpc/connect': '^2.1.2',
  '@google-cloud/pubsub': '^6',
  // OpenTelemetry 2.x peers require @opentelemetry/api <1.10.0.
  '@opentelemetry/api': '~1.9.0',
  '@opentelemetry/sdk-trace-base': '^2.9.0',
  '@opentelemetry/resources': '^2.9.0',
  '@opentelemetry/context-async-hooks': '^2.0.0',
  amqplib: '0.10.x',
  hono: '^4.12.30',
  ioredis: '5.x',
  kafkajs: '2.x',
  nats: '2.x',
  pino: '10.x',
  // The Node WebSocket server is an optional peer of `@setu-ts/runtime`; a
  // package manager never installs it for the consumer (M113h §3.8).
  ws: '^8.18.0',
  zod: '^4.6.6',
};

/** A client package name {@linkcode CLIENT_RANGES} knows. */
export type ClientPackage = keyof typeof CLIENT_RANGES & string;

/**
 * Adds client packages to a host's npm dependencies and Deno import map.
 *
 * @param host - The resolved host
 * @param clients - The packages to add
 * @returns The host with each client declared for both manifest kinds
 */
export function withClientDependencies(
  host: ResolvedHost,
  clients: readonly string[],
): ResolvedHost {
  if (clients.length === 0) return host;
  const dependencies = { ...host.extraDependencies };
  const imports = { ...host.extraImports };
  for (const name of clients) {
    const range = CLIENT_RANGES[name];
    if (range === undefined) {
      throw new Error(`No client range for ${name}; add it to CLIENT_RANGES.`);
    }
    dependencies[name] = range;
    imports[name] = `npm:${name}@${range}`;
  }
  return { ...host, extraDependencies: dependencies, extraImports: imports };
}
