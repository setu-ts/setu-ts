/**
 * @module
 *
 * In-memory event bus plugin for domain events.
 *
 * Package stub created in Milestone 0. The implementation follows in this
 * package's milestone — see ROADMAP.md.
 */
export { EventsPlugin } from './plugin/events-plugin.ts';
export { InMemoryEventBus } from './bus/in-memory-event-bus.ts';
export { defineDomainEvent, DomainEvent } from './events/domain-event.ts';
export { IntegrationEvent } from './events/integration-event.ts';
export type { IEventHandler } from './handlers/event-handler.ts';
export { subscribeHandler } from './handlers/event-handler.ts';
export type { EventsPluginOptions } from './interfaces/index.ts';

// Re-export common types for convenience
export type { EventHandler, IDomainEvent, IEventBus, Unsubscribe } from '@hono-enterprise/common';
