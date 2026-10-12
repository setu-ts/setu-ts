/**
 * The client libraries a selected transport needs installed in the project.
 *
 * Every broker, queue and RPC client is an OPTIONAL peer of the plugin that
 * loads it, and a package manager never installs an optional peer for the
 * consumer — so a project scaffolded with `--broker redis` failed at its first
 * boot, at the plugin's lazy `import('ioredis')`. The selected arm adds its
 * client to the project itself: a caret range in `package.json`, an `npm:`
 * entry in a Deno import map. The ranges are the plugins' own peer ranges, and
 * a test holds this table equal to the framework's dependency table so the two
 * cannot drift.
 *
 * @module
 */

import type { ResolvedHost } from './project-files.ts';

/** Each client package and the range its plugin declares as a peer. */
export const CLIENT_RANGES: Readonly<Record<string, string>> = {
  '@aws-sdk/client-sqs': '^3',
  '@azure/service-bus': '^7',
  '@bufbuild/protobuf': '^2.7.0',
  '@connectrpc/connect': '^2.1.2',
  '@google-cloud/pubsub': '^6',
  amqplib: '0.10.x',
  ioredis: '5.x',
  kafkajs: '2.x',
  nats: '2.x',
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
    if (range === undefined) throw new Error(`No client range for ${name}; add it to CLIENT_RANGES.`);
    dependencies[name] = range;
    imports[name] = `npm:${name}@${range}`;
  }
  return { ...host, extraDependencies: dependencies, extraImports: imports };
}
