/**
 * Shared runtime gate for cloud message brokers.
 *
 * Throws {@linkcode CloudBrokerUnavailableError} when the runtime is
 * Cloudflare Workers and the SDK cannot function (gRPC, AMQP, long-poll —
 * not `fetch`). Called at the start of {@linkcode connect()}, before any
 * SDK load attempt.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { CloudBrokerUnavailableError } from '../errors.ts';

/**
 * Asserts that the runtime is NOT Cloudflare Workers, throwing a named error
 * when the SDK cannot operate on the edge.
 *
 * @param runtime - The runtime services
 * @param backend - Human-readable backend name (e.g. "GCP Pub/Sub")
 * @param specifier - The npm specifier (e.g. "npm:@google-cloud/pubsub@^6")
 * @throws {CloudBrokerUnavailableError} When platform is Cloudflare Workers
 */
export function assertNotCloudflareWorkers(
  runtime: IRuntimeServices,
  backend: string,
  specifier: string,
): void {
  if (runtime.platform() === 'cloudflare-workers') {
    throw new CloudBrokerUnavailableError(backend, specifier);
  }
}
