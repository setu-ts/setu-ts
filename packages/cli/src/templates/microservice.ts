/**
 * The `microservice` project template.
 *
 * @module
 */

import type { TemplateDefinition } from './registry.ts';
import { REST_MIDDLEWARE, REST_PLUGINS } from './rest.ts';

/**
 * `microservice` — `rest` plus the pieces a service needs to talk to others:
 * messaging, background queues, resilience policies, tracing, and service
 * discovery.
 *
 * Composed from {@linkcode REST_PLUGINS} rather than repeating it, so the two
 * templates cannot drift.
 *
 * Refused on Cloudflare Workers: the messaging and queue plugins reach brokers
 * over raw sockets and the discovery plugin's DNS-SRV arm needs
 * `IRuntimeServices.dns`, none of which Workers provides. Scaffolding that
 * pairing would deploy cleanly and then fail at first use.
 */
export const MICROSERVICE_TEMPLATE: TemplateDefinition = {
  name: 'microservice',
  description: 'REST plus messaging, queues, resilience, telemetry, and service discovery',
  plugins: [
    ...REST_PLUGINS,
    { pkg: 'messaging-plugin', symbol: 'MessagingPlugin' },
    { pkg: 'queue-plugin', symbol: 'QueuePlugin' },
    { pkg: 'resilience-plugin', symbol: 'ResiliencePlugin' },
    { pkg: 'telemetry-plugin', symbol: 'TelemetryPlugin' },
    // The only wiring here that takes arguments: `ServiceDiscoveryPlugin`'s
    // options are a union discriminated on `provider` with no default arm, so a
    // bare call does not type-check. `'static'` is the one arm that needs no
    // backend and no credential, and the map is left empty rather than carrying
    // a sample service — a sample would resolve to an instance pointing at a
    // dead port, which is worse than resolving nothing. An unknown name
    // resolves to `[]`, so this is inert until the developer fills it in.
    {
      pkg: 'service-discovery-plugin',
      symbol: 'ServiceDiscoveryPlugin',
      args: "{ provider: 'static', services: {} }",
    },
  ],
  middleware: REST_MIDDLEWARE,
  unsupported: {
    'cloudflare-workers':
      'the messaging and queue plugins reach brokers over raw sockets and service discovery ' +
      'resolves DNS-SRV records, neither of which Workers provides',
  },
};
