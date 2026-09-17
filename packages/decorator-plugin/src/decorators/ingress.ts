/**
 * Decorators for non-HTTP ingress handlers.
 *
 * These decorators record registrations consumed by {@linkcode DecoratorPlugin}
 * during its `onInit` lifecycle phase. They do not import ingress plugins;
 * registration happens through capabilities resolved from the service registry.
 *
 * @module
 */
import type {
  IIngressBehavior,
  IPipelineBehavior,
  ProcessOptions,
  ScheduleOptions,
  SubscribeOptions,
} from '@setu-ts/common';

import { classDecorator, methodDecorator } from '../metadata/context-bridge.ts';
import type { SetuClassDecorator, SetuMethodDecorator } from '../metadata/context-bridge.ts';

/**
 * Registers a queue processor for a job name.
 *
 * @param name - Queue job name
 * @param options - Processor concurrency options
 * @returns A standard method decorator
 */
export function Processor(name: string, options?: ProcessOptions): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, {
      kind: 'queue',
      handler,
      name,
      ...(options !== undefined ? { options } : {}),
    });
  });
}

/**
 * Registers a UTC cron job. The decorated method name is its scheduler name.
 *
 * @param expression - Five-field UTC cron expression
 * @param options - Scheduled job payload and retry options
 * @returns A standard method decorator
 */
export function Cron(expression: string, options?: ScheduleOptions): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, {
      kind: 'scheduler-cron',
      handler,
      expression,
      ...(options !== undefined ? { options } : {}),
    });
  });
}

/**
 * Registers a fixed-interval job. The decorated method name is its scheduler name.
 *
 * @param intervalMs - Interval in milliseconds
 * @param options - Scheduled job payload and retry options
 * @returns A standard method decorator
 */
export function Every(intervalMs: number, options?: ScheduleOptions): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, {
      kind: 'scheduler-every',
      handler,
      intervalMs,
      ...(options !== undefined ? { options } : {}),
    });
  });
}

/**
 * Subscribes a method to a domain-event type.
 *
 * @param type - Domain-event type name
 * @returns A standard method decorator
 */
export function OnEvent(type: string): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, { kind: 'event', handler, type });
  });
}

/**
 * Subscribes a method to a broker topic.
 *
 * @param topic - Broker topic
 * @param options - Consumer-group options
 * @returns A standard method decorator
 */
export function Subscribe(topic: string, options?: SubscribeOptions): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, {
      kind: 'messaging',
      handler,
      topic,
      ...(options !== undefined ? { options } : {}),
    });
  });
}

/**
 * Declares the WebSocket path served by a gateway class.
 *
 * @param path - Exact upgrade path
 * @returns A standard class decorator
 */
export function Gateway(path: string): SetuClassDecorator {
  return classDecorator((store, target) => {
    store.addIngress(target, { kind: 'gateway', path });
  });
}

/** Registers a method as a gateway's open handler. */
export const OnOpen: SetuMethodDecorator = methodDecorator((store, target, handler) => {
  store.addIngress(target, { kind: 'websocket-open', handler });
});

/** Registers a method as a gateway's message handler. */
export const OnMessage: SetuMethodDecorator = methodDecorator((store, target, handler) => {
  store.addIngress(target, { kind: 'websocket-message', handler });
});

/** Registers a method as a gateway's close handler. */
export const OnClose: SetuMethodDecorator = methodDecorator((store, target, handler) => {
  store.addIngress(target, { kind: 'websocket-close', handler });
});

/**
 * Registers a command handler for a command type.
 *
 * @param type - Command type name
 * @returns A standard method decorator
 */
export function CommandHandler(type: string): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, { kind: 'command', handler, type });
  });
}

/**
 * Registers a query handler for a query type.
 *
 * @param type - Query type name
 * @returns A standard method decorator
 */
export function QueryHandler(type: string): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, { kind: 'query', handler, type });
  });
}

/**
 * Attaches non-HTTP ingress behaviours to one handler.
 *
 * This decorator is valid for queue, scheduler, messaging, and gateway handlers.
 * Event, command, and query handlers using it are refused at application startup.
 *
 * @param behaviors - Behaviours to run around the decorated handler
 * @returns A standard method decorator
 */
export function UseIngressBehaviors(
  ...behaviors: readonly IIngressBehavior[]
): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, { kind: 'ingress-behaviors', handler, behaviors });
  });
}

/**
 * Attaches CQRS pipeline behaviours to one command or query handler.
 *
 * Queue, scheduler, event, messaging, and gateway handlers using this decorator
 * are refused at application startup.
 *
 * @param behaviors - Behaviours to run around the decorated handler
 * @returns A standard method decorator
 */
export function UsePipelineBehaviors(
  ...behaviors: readonly IPipelineBehavior[]
): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.addIngress(target, { kind: 'pipeline-behaviors', handler, behaviors });
  });
}
