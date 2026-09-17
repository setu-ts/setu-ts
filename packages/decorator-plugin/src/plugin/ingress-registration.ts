/** Registers non-HTTP ingress metadata through public capability contracts. */
import type {
  Constructor,
  ICommandBus,
  IEventBus,
  IMessageBroker,
  IPluginContext,
  IQueryBus,
  IQueue,
  IScheduler,
  IWebSocketService,
  WebSocketHandlers,
} from '@setu-ts/common';
import { CAPABILITIES, composeBehaviorChain } from '@setu-ts/common';

import { className } from '../internal.ts';
import type { IngressMetadata } from '../metadata/metadata-store.ts';
import { metadataStore } from '../metadata/metadata-store.ts';

type Method = (...args: unknown[]) => unknown | Promise<unknown>;

/** Resolves a bound decorated method, refusing a stale metadata entry clearly. */
function methodOf(instance: unknown, target: Constructor, name: string): Method {
  const value = (instance as Record<string, unknown>)[name];
  if (typeof value !== 'function') {
    throw new Error(`${className(target)}.${name} is decorated as ingress but is not a method.`);
  }
  return (...args: unknown[]): unknown | Promise<unknown> => value.apply(instance, args);
}

/** Throws a startup diagnostic when a decorated ingress has no provider. */
function requireCapability<T extends object>(
  ctx: IPluginContext,
  token: string,
  plugin: string,
  target: Constructor,
  handler: string,
): T {
  if (ctx.services.has(token)) {
    return ctx.services.get<T>(token);
  }
  if (ctx.container?.has(token) === true) {
    return ctx.container.resolve<T>(token);
  }
  throw new Error(
    `${className(target)}.${handler} is decorated for non-HTTP ingress, but ${plugin} ` +
      `is not registered to provide ${token}. Register ${plugin} (or another provider of ${token}).`,
  );
}

function primaryFor(
  entries: readonly IngressMetadata[],
  handler: string,
): IngressMetadata | undefined {
  return entries.find(
    (entry) => 'handler' in entry && entry.handler === handler && !entry.kind.endsWith('behaviors'),
  );
}

function isIngressBehaviorEntry(
  entry: IngressMetadata,
): entry is Extract<IngressMetadata, { readonly kind: 'ingress-behaviors' }> {
  return entry.kind === 'ingress-behaviors';
}

function isPipelineBehaviorEntry(
  entry: IngressMetadata,
): entry is Extract<IngressMetadata, { readonly kind: 'pipeline-behaviors' }> {
  return entry.kind === 'pipeline-behaviors';
}

function isWebsocketEntry(
  entry: IngressMetadata,
): entry is Extract<
  IngressMetadata,
  { readonly kind: 'websocket-open' | 'websocket-message' | 'websocket-close' }
> {
  return entry.kind === 'websocket-open' || entry.kind === 'websocket-message' ||
    entry.kind === 'websocket-close';
}

function ingressBehaviors(
  entries: readonly IngressMetadata[],
  target: Constructor,
  handler: string,
): readonly import('@setu-ts/common').IIngressBehavior[] {
  const behaviors = entries
    .filter(isIngressBehaviorEntry)
    .filter((entry) => entry.handler === handler)
    .flatMap((entry) => entry.behaviors);
  if (behaviors.length === 0) return [];
  const primary = primaryFor(entries, handler);
  if (
    primary === undefined ||
    ![
      'queue',
      'scheduler-cron',
      'scheduler-every',
      'messaging',
      'websocket-open',
      'websocket-message',
      'websocket-close',
    ].includes(primary.kind)
  ) {
    throw new Error(
      `${className(target)}.${handler} uses @UseIngressBehaviors, but its decorated ingress ` +
        'does not support IIngressBehavior. Use @UsePipelineBehaviors only on CQRS handlers.',
    );
  }
  return behaviors;
}

function pipelineBehaviors(
  entries: readonly IngressMetadata[],
  target: Constructor,
  handler: string,
): readonly import('@setu-ts/common').IPipelineBehavior[] {
  const behaviors = entries
    .filter(isPipelineBehaviorEntry)
    .filter((entry) => entry.handler === handler)
    .flatMap((entry) => entry.behaviors);
  if (behaviors.length === 0) return [];
  const primary = primaryFor(entries, handler);
  if (primary?.kind !== 'command' && primary?.kind !== 'query') {
    throw new Error(
      `${
        className(target)
      }.${handler} uses @UsePipelineBehaviors, but it is not a command or query handler. ` +
        'Use @UseIngressBehaviors on supported non-CQRS ingress handlers.',
    );
  }
  return behaviors;
}

/** Refuses HTTP guards whose request context cannot exist on non-HTTP ingress. */
function refuseHttpGuards(
  target: Constructor,
  entries: readonly IngressMetadata[],
): void {
  if ((metadataStore.getController(target)?.guards.length ?? 0) > 0) {
    throw new Error(
      `${className(target)} uses @UseGuards with non-HTTP ingress. ` +
        'Use @UseIngressBehaviors or @UsePipelineBehaviors for the handler kind instead.',
    );
  }
  const methods = metadataStore.getMethods(target);
  for (const entry of entries) {
    if (!('handler' in entry)) continue;
    const method = methods.get(entry.handler);
    if (method !== undefined && method.guards.length > 0) {
      throw new Error(
        `${className(target)}.${entry.handler} uses @UseGuards with non-HTTP ingress. ` +
          'Use @UseIngressBehaviors or @UsePipelineBehaviors for the handler kind instead.',
      );
    }
  }
}

/**
 * Registers the non-HTTP declarations of one explicit class list.
 *
 * This is intentionally a push pass: no ingress plugin reads decorator metadata,
 * and every call uses the public service interface registered under its capability.
 */
export async function registerIngresses(
  ctx: IPluginContext,
  targets: readonly Constructor[],
  instantiate: (target: Constructor) => unknown,
): Promise<void> {
  for (const target of targets) {
    const entries = metadataStore.getIngress(target);
    if (entries.length === 0) continue;
    const instance = instantiate(target);

    refuseHttpGuards(target, entries);
    for (const entry of entries) {
      if (entry.kind === 'ingress-behaviors') ingressBehaviors(entries, target, entry.handler);
      if (entry.kind === 'pipeline-behaviors') pipelineBehaviors(entries, target, entry.handler);
    }

    for (const entry of entries) {
      if (
        entry.kind === 'ingress-behaviors' || entry.kind === 'pipeline-behaviors' ||
        entry.kind === 'gateway' || entry.kind.startsWith('websocket-')
      ) continue;
      const method = methodOf(instance, target, entry.handler);
      switch (entry.kind) {
        case 'queue': {
          const queue = requireCapability<IQueue>(
            ctx,
            CAPABILITIES.QUEUE,
            'QueuePlugin',
            target,
            entry.handler,
          );
          const behaviors = ingressBehaviors(entries, target, entry.handler);
          queue.process(entry.name, async (job) => {
            await composeBehaviorChain(
              {
                kind: 'queue',
                name: entry.name,
                payload: job,
                attempt: job.attempts,
                ...(job.headers !== undefined ? { headers: job.headers } : {}),
              },
              behaviors,
              async () => await method(job),
            );
          }, entry.options);
          break;
        }
        case 'scheduler-cron': {
          const scheduler = requireCapability<IScheduler>(
            ctx,
            CAPABILITIES.SCHEDULER,
            'SchedulerPlugin',
            target,
            entry.handler,
          );
          const behaviors = ingressBehaviors(entries, target, entry.handler);
          await scheduler.cron(entry.handler, entry.expression, async (job) => {
            await composeBehaviorChain(
              { kind: 'scheduler', name: entry.handler, payload: job, attempt: job.attempts },
              behaviors,
              async () => await method(job),
            );
          }, entry.options);
          break;
        }
        case 'scheduler-every': {
          const scheduler = requireCapability<IScheduler>(
            ctx,
            CAPABILITIES.SCHEDULER,
            'SchedulerPlugin',
            target,
            entry.handler,
          );
          const behaviors = ingressBehaviors(entries, target, entry.handler);
          await scheduler.every(entry.handler, entry.intervalMs, async (job) => {
            await composeBehaviorChain(
              { kind: 'scheduler', name: entry.handler, payload: job, attempt: job.attempts },
              behaviors,
              async () => await method(job),
            );
          }, entry.options);
          break;
        }
        case 'event': {
          const events = requireCapability<IEventBus>(
            ctx,
            CAPABILITIES.EVENTS,
            'EventsPlugin',
            target,
            entry.handler,
          );
          events.subscribe(entry.type, async (event) => {
            await method(event);
          });
          break;
        }
        case 'messaging': {
          const broker = requireCapability<IMessageBroker>(
            ctx,
            CAPABILITIES.MESSAGING,
            'MessagingPlugin',
            target,
            entry.handler,
          );
          const behaviors = ingressBehaviors(entries, target, entry.handler);
          await broker.subscribe(entry.topic, async (message, metadata) => {
            await composeBehaviorChain(
              {
                kind: 'messaging',
                name: entry.topic,
                payload: message,
                ...(metadata.headers !== undefined ? { headers: metadata.headers } : {}),
              },
              behaviors,
              async () => await method(message, metadata),
            );
          }, entry.options);
          break;
        }
        case 'command': {
          const bus = requireCapability<ICommandBus>(
            ctx,
            CAPABILITIES.COMMAND_BUS,
            'CqrsPlugin',
            target,
            entry.handler,
          );
          const behaviors = pipelineBehaviors(entries, target, entry.handler);
          bus.register(entry.type, {
            handle: async (command) =>
              await composeBehaviorChain(command, behaviors, async () => await method(command)),
          });
          break;
        }
        case 'query': {
          const bus = requireCapability<IQueryBus>(
            ctx,
            CAPABILITIES.QUERY_BUS,
            'CqrsPlugin',
            target,
            entry.handler,
          );
          const behaviors = pipelineBehaviors(entries, target, entry.handler);
          bus.register(entry.type, {
            handle: async (query) =>
              await composeBehaviorChain(query, behaviors, async () => await method(query)),
          });
          break;
        }
      }
    }

    const gateway = entries.find((entry) => entry.kind === 'gateway');
    const websocketEntries = entries.filter(isWebsocketEntry);
    if (websocketEntries.length > 0 && gateway === undefined) {
      throw new Error(
        `${className(target)} has WebSocket handlers but no @Gateway(path) declaration.`,
      );
    }
    if (gateway !== undefined) {
      const websocket = requireCapability<IWebSocketService>(
        ctx,
        CAPABILITIES.WEBSOCKET,
        'WebSocketPlugin',
        target,
        'gateway',
      );
      const handlers: WebSocketHandlers = {};
      for (const entry of websocketEntries) {
        const method = methodOf(instance, target, entry.handler);
        const behaviors = ingressBehaviors(entries, target, entry.handler);
        if (entry.kind === 'websocket-open') {
          handlers.onOpen = async (connection, context) => {
            await composeBehaviorChain(
              { kind: 'websocket', name: gateway.path, payload: context },
              behaviors,
              async () => await method(connection, context),
            );
          };
        }
        if (entry.kind === 'websocket-message') {
          handlers.onMessage = async (connection, data) => {
            await composeBehaviorChain(
              { kind: 'websocket', name: gateway.path, payload: data },
              behaviors,
              async () => await method(connection, data),
            );
          };
        }
        if (entry.kind === 'websocket-close') {
          handlers.onClose = async (connection, event) => {
            await composeBehaviorChain(
              { kind: 'websocket', name: gateway.path, payload: event },
              behaviors,
              async () => await method(connection, event),
            );
          };
        }
      }
      websocket.route(gateway.path, handlers);
    }
  }
}
