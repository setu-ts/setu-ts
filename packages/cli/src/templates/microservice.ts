/**
 * The `microservice` project template.
 *
 * @module
 */

import type { TemplateDefinition, Wiring } from './registry.ts';
import { REST_MIDDLEWARE, REST_PLUGINS } from './rest.ts';
import {
  MODULE_SEAM_FILES,
  MODULE_SEAM_LOCAL_IMPORT,
  MODULE_SEAM_MANIFEST,
  withModuleSeam,
} from './module-seam.ts';
import {
  decoratorSeamExtras,
  seamFiles,
  seamLocalImports,
  seamPluginSpreads,
  seamSetupCalls,
  seamsFor,
  withPluginOptionSeams,
} from './seam.ts';

/**
 * What `microservice` adds on top of the REST set.
 *
 * `CqrsPlugin` and `EventsPlugin` are the two additions this tier gained with the
 * generated-artifact seams. They are here rather than in `rest` for two reasons: CQRS
 * and domain events are the patterns a service-to-service tier is missing, and they
 * are the only host a project can have for `setu generate command-handler`,
 * `query-handler` and `event-handler` — all three were gated on plugins that no
 * template installed, so their output could never be wired in a scaffolded project.
 *
 * Both satisfy this tier's rule that a scaffolded plugin must construct with no
 * configuration: each is in-memory, zero-dependency, and needs no credential. Neither
 * needs a socket, so neither joins the Workers refusal below.
 */
const MICROSERVICE_ADDITIONS: readonly Wiring[] = [
  { pkg: 'messaging-plugin', symbol: 'MessagingPlugin' },
  { pkg: 'queue-plugin', symbol: 'QueuePlugin' },
  { pkg: 'resilience-plugin', symbol: 'ResiliencePlugin' },
  { pkg: 'telemetry-plugin', symbol: 'TelemetryPlugin' },
  { pkg: 'cqrs-plugin', symbol: 'CqrsPlugin' },
  { pkg: 'events-plugin', symbol: 'EventsPlugin' },
  // The only wiring here that takes arguments for a reason other than a seam:
  // `ServiceDiscoveryPlugin`'s options are a union discriminated on `provider` with no
  // default arm, so a bare call does not type-check. `'static'` is the one arm that
  // needs no backend and no credential, and the map is left empty rather than carrying
  // a sample service — a sample would resolve to an instance pointing at a
  // dead port, which is worse than resolving nothing. An unknown name
  // resolves to `[]`, so this is inert until the developer fills it in.
  {
    pkg: 'service-discovery-plugin',
    symbol: 'ServiceDiscoveryPlugin',
    args: "{ provider: 'static', services: {} }",
  },
];

/** Every plugin a microservice project registers. */
const MICROSERVICE_PLUGINS: readonly Wiring[] = [...REST_PLUGINS, ...MICROSERVICE_ADDITIONS];

/** The `@setu-ts` packages this template registers, for seam selection. */
const MICROSERVICE_PACKAGES: ReadonlySet<string> = new Set(
  MICROSERVICE_PLUGINS.map((p) => p.pkg),
);

/**
 * The seams a microservice project can consume — all ten, since this is the only
 * template registering the CQRS and events plugins.
 */
const MICROSERVICE_SEAMS = seamsFor(MICROSERVICE_PACKAGES);

/** The standalone controller and service barrels the decorator wiring must also name. */
const MICROSERVICE_DECORATOR_EXTRAS = decoratorSeamExtras(MICROSERVICE_SEAMS);

/**
 * `microservice` — `rest` plus the pieces a service needs to talk to others:
 * messaging, background queues, resilience policies, tracing, service discovery, and
 * the in-memory CQRS and domain-event buses.
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
  description:
    'REST plus messaging, queues, resilience, telemetry, service discovery, CQRS, and events',
  plugins: withPluginOptionSeams(
    withModuleSeam(
      MICROSERVICE_PLUGINS,
      MICROSERVICE_DECORATOR_EXTRAS.controllers,
      MICROSERVICE_DECORATOR_EXTRAS.services,
    ),
    MICROSERVICE_SEAMS,
  ),
  middleware: REST_MIDDLEWARE,
  localImports: [MODULE_SEAM_LOCAL_IMPORT, ...seamLocalImports(MICROSERVICE_SEAMS)],
  files: [...MODULE_SEAM_FILES, ...seamFiles(MICROSERVICE_SEAMS)],
  manifest: MODULE_SEAM_MANIFEST,
  pluginSpreads: seamPluginSpreads(MICROSERVICE_SEAMS),
  setupCalls: seamSetupCalls(MICROSERVICE_SEAMS),
  unsupported: {
    'cloudflare-workers':
      'the messaging and queue plugins reach brokers over raw sockets, which Workers does not provide',
  },
};
