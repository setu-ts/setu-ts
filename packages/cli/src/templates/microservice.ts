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
 * over raw sockets, which Workers does not provide. Scaffolding that pairing
 * would deploy cleanly and then fail at first use.
 *
 * Service discovery is deliberately NOT part of that refusal. The wiring below
 * selects the `'static'` arm, which contacts no backend at all; only
 * `DnsProvider` reads `IRuntimeServices.dns`, and nothing here selects it.
 * Naming DNS-SRV in the refusal would state a blocker the generated config
 * never meets, and would imply the plugin is unusable on Workers when its
 * static, Consul and Kubernetes arms are plain HTTP.
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
      'the messaging and queue plugins reach brokers over raw sockets, which Workers does not provide',
  },
};
