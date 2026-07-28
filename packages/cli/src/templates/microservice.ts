/**
 * The `microservice` project template.
 *
 * @module
 */

import type { TemplateDefinition } from './registry.ts';
import { REST_MIDDLEWARE, REST_PLUGINS } from './rest.ts';

/**
 * `microservice` — `rest` plus the pieces a service needs to talk to others:
 * messaging, background queues, resilience policies, and tracing.
 *
 * Composed from {@linkcode REST_PLUGINS} rather than repeating it, so the two
 * templates cannot drift.
 *
 * Refused on Cloudflare Workers: the messaging and queue plugins reach brokers
 * over raw sockets, which Workers does not provide. Scaffolding that pairing
 * would deploy cleanly and then fail at first use.
 */
export const MICROSERVICE_TEMPLATE: TemplateDefinition = {
  name: 'microservice',
  description: 'REST plus messaging, queues, resilience, and telemetry',
  plugins: [
    ...REST_PLUGINS,
    { pkg: 'messaging-plugin', symbol: 'MessagingPlugin' },
    { pkg: 'queue-plugin', symbol: 'QueuePlugin' },
    { pkg: 'resilience-plugin', symbol: 'ResiliencePlugin' },
    { pkg: 'telemetry-plugin', symbol: 'TelemetryPlugin' },
  ],
  middleware: REST_MIDDLEWARE,
  unsupported: {
    'cloudflare-workers':
      'the messaging and queue plugins reach brokers over raw sockets, which Workers does not provide',
  },
};
