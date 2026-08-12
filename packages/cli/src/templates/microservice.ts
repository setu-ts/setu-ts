/**
 * The `microservice` project template.
 *
 * @module
 */

import type { RuntimeSwap, TemplateDefinition, Wiring } from './registry.ts';
import { REST_MIDDLEWARE, REST_PLUGINS } from './rest.ts';
import { FUNCTIONAL_MODULE_MANIFEST } from './module-seam.ts';
import {
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
 * needs a socket, so neither is part of {@linkcode WORKERS_SWAP}.
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

/** The Durable Object class a Workers project exports to serve RPC replies. */
const REPLY_INBOX_MODULE = `/**
 * The Durable Object serving brokered request-reply.
 *
 * A Cloudflare queue reaches exactly one consumer Worker and never the caller
 * waiting for a reply, so \`broker.request(...)\` needs a second, addressable
 * place to be answered. This class is it: the caller holds a WebSocket to an
 * object named after its own inbox, and the responder posts the reply to it.
 *
 * The behavior lives in \`ReplyInboxObjectCore\`; this class exists because
 * Cloudflare requires the Durable Object class to be exported by YOUR Worker,
 * which no library can do on your behalf.
 *
 * It deliberately does NOT \`extends DurableObject\`. That base class lives in
 * \`cloudflare:workers\`, a specifier only a Worker toolchain can resolve — so
 * importing it would break \`deno check\` on this project. workerd accepts a
 * plain class that takes \`(ctx, env)\`, which is the older and still-supported
 * form. Extend the base class instead if you want \`this.env\`.
 */
import type {
  IDurableObjectState,
  IDurableObjectWebSocket,
} from '@setu-ts/cloudflare-plugin';
import { ReplyInboxObjectCore } from '@setu-ts/cloudflare-plugin';

export class ReplyInboxObject {
  readonly #core: ReplyInboxObjectCore;

  constructor(ctx: IDurableObjectState, _env: Readonly<Record<string, unknown>>) {
    this.#core = new ReplyInboxObjectCore(ctx);
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }

  webSocketClose(ws: IDurableObjectWebSocket, code: number, reason: string): void {
    this.#core.webSocketClose(ws, code, reason);
  }

  webSocketError(ws: IDurableObjectWebSocket): void {
    this.#core.webSocketError(ws);
  }
}
`;

/**
 * What `microservice` becomes on Cloudflare Workers.
 *
 * The template used to refuse this target outright, because `MessagingPlugin`
 * and `QueuePlugin` reach brokers over raw sockets. The refusal was correct
 * about those two plugins and wrong about the capabilities: Cloudflare serves
 * both itself, through Queues and a Durable Object, so the tier keeps
 * `CAPABILITIES.MESSAGING` and `CAPABILITIES.QUEUE` — just from a different
 * provider. Everything else in the set is in-memory or `fetch`-based and was
 * never the blocker.
 *
 * `max_batch_timeout = 0` on the messages consumer is load-bearing rather than
 * a tuning choice: the platform default is 5 seconds, which alone exhausts the
 * default reply budget, so every `request()` against a default queue would time
 * out.
 */
const WORKERS_SWAP = {
  removePackages: ['messaging-plugin', 'queue-plugin'],
  addPlugins: [
    {
      pkg: 'cloudflare-plugin',
      symbol: 'CloudflarePlugin',
      workersArgs: "{ env, messaging: { binding: 'MESSAGES', rpc: { binding: 'REPLY_INBOX' } }, " +
        "queue: { binding: 'JOBS' } }",
    },
  ],
  workerExports: [
    {
      name: 'queue',
      payloadType: 'IQueueMessageBatch',
      payloadPkg: 'cloudflare-plugin',
      // Both queues this project consumes, routed by NAME. One handler for both
      // would hand the messaging broker its job batches — which it cannot read,
      // so it would retry them until the queue dead-lettered them — and leaving
      // the job queue unconsumed would discard every `queue.add()` silently.
      routes: [
        { queueName: 'messages', pkg: 'cloudflare-plugin', symbol: 'createMessagingHandler' },
        { queueName: 'jobs', pkg: 'cloudflare-plugin', symbol: 'createQueueHandler' },
      ],
    },
  ],
  files: [{ path: 'src/reply-inbox-object.ts', contents: REPLY_INBOX_MODULE }],
  entryReExports: ["export { ReplyInboxObject } from './reply-inbox-object.ts';"],
  wranglerToml: `
[[queues.producers]]
binding = "MESSAGES"
queue = "messages"

[[queues.producers]]
binding = "JOBS"
queue = "jobs"

# \`max_batch_timeout = 0\` is REQUIRED for request/reply: the platform default of
# 5s alone exhausts the default reply budget, so every request() would time out.
# It applies to this queue only, so background jobs below keep the platform's
# batching.
[[queues.consumers]]
queue = "messages"
max_batch_size = 1
max_batch_timeout = 0

# Background jobs, consumed by the same \`queue\` export and told apart by this
# name. Without this stanza nothing consumes the queue \`IQueue.add()\` writes to,
# so every enqueued job is discarded once the platform's retention elapses.
[[queues.consumers]]
queue = "jobs"

[[durable_objects.bindings]]
name = "REPLY_INBOX"
class_name = "ReplyInboxObject"

[[migrations]]
tag = "v1"
new_classes = ["ReplyInboxObject"]
`,
} as const satisfies RuntimeSwap;

/** The `@setu-ts` packages this template registers, for seam selection. */
const MICROSERVICE_PACKAGES: ReadonlySet<string> = new Set(
  MICROSERVICE_PLUGINS.map((p) => p.pkg),
);

/**
 * The seams a microservice project can consume — all ten, since this is the only
 * template registering the CQRS and events plugins.
 */
const MICROSERVICE_SEAMS = seamsFor(MICROSERVICE_PACKAGES);

/**
 * `microservice` — `rest` plus the pieces a service needs to talk to others:
 * messaging, background queues, resilience policies, tracing, service discovery, and
 * the in-memory CQRS and domain-event buses.
 *
 * Composed from {@linkcode REST_PLUGINS} rather than repeating it, so the two
 * templates cannot drift.
 *
 * Supported on all four runtime targets. On Cloudflare Workers the messaging and
 * queue plugins — which reach brokers over raw sockets — are swapped for
 * `CloudflarePlugin`, which serves both capabilities from Cloudflare Queues and
 * a Durable Object. See {@linkcode WORKERS_SWAP}.
 *
 * Service discovery is deliberately NOT part of that swap. The wiring below
 * selects the `'static'` arm, which contacts no backend at all; only
 * `DnsProvider` reads `IRuntimeServices.dns`, and nothing here selects it, so
 * the plugin runs unchanged on Workers.
 */
export const MICROSERVICE_TEMPLATE: TemplateDefinition = {
  name: 'microservice',
  description:
    'REST plus messaging, queues, resilience, telemetry, service discovery, CQRS, and events',
  plugins: withPluginOptionSeams(MICROSERVICE_PLUGINS, MICROSERVICE_SEAMS),
  middleware: REST_MIDDLEWARE,
  localImports: seamLocalImports(MICROSERVICE_SEAMS),
  files: seamFiles(MICROSERVICE_SEAMS),
  pluginSpreads: seamPluginSpreads(MICROSERVICE_SEAMS),
  setupCalls: seamSetupCalls(MICROSERVICE_SEAMS),
  manifest: FUNCTIONAL_MODULE_MANIFEST,
  runtimeSwaps: { 'cloudflare-workers': WORKERS_SWAP },
};
