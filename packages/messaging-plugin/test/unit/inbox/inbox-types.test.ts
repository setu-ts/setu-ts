/**
 * The `onIntegrationEvent` overloads (M108 §3.3), asserted at COMPILE time:
 * every existing call keeps `SubscriptionDefinition`; an `inbox` call — written
 * inline OR through an options variable — is a `RegistryFactory`; `ReturnType`
 * still reads the legacy signature; the unit-of-work type is inferred from the
 * handler's annotation.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { RegistryFactory, SubscribeOptions } from '@setu-ts/common';
import { onIntegrationEvent } from '../../../src/index.ts';
import type {
  IntegrationEventSubscribeOptions,
  SubscriptionDefinition,
} from '../../../src/index.ts';
import { hired } from '../../fixtures/inbox.ts';

/** A unit-of-work shape a store would hand the handler. */
interface Uow {
  getRepository(entity: string): { create(row: object): Promise<unknown> };
}

describe('onIntegrationEvent overloads', () => {
  it('keeps every existing call a SubscriptionDefinition', () => {
    const bare: SubscriptionDefinition = onIntegrationEvent(hired, (p) => {
      const id: string = p.personId;
      void id;
    });
    const queued: SubscriptionDefinition = onIntegrationEvent(hired, () => {}, { queue: 'q' });
    const variable: SubscribeOptions = { queue: 'q' };
    const viaVariable: SubscriptionDefinition = onIntegrationEvent(hired, () => {}, variable);
    expect([bare, queued, viaVariable].every((d) => typeof d.handler === 'function')).toBe(true);
  });

  it('types an inbox call as a RegistryFactory, inline or through a variable', () => {
    const inline: RegistryFactory<SubscriptionDefinition> = onIntegrationEvent(
      hired,
      () => {},
      { inbox: { consumer: 'payroll' } },
    );
    const variable = { queue: 'p', inbox: { consumer: 'p' } };
    const viaVariable: RegistryFactory<SubscriptionDefinition> = onIntegrationEvent(
      hired,
      () => {},
      variable,
    );
    const declared: IntegrationEventSubscribeOptions = { inbox: { consumer: 'p' } };
    const viaDeclared: RegistryFactory<SubscriptionDefinition> = onIntegrationEvent(
      hired,
      () => {},
      declared,
    );
    // @ts-expect-error — an inbox call is never a SubscriptionDefinition.
    const wrong: SubscriptionDefinition = onIntegrationEvent(hired, () => {}, variable);
    expect([inline, viaVariable, viaDeclared, wrong].every((f) => typeof f === 'function'))
      .toBe(true);
  });

  it('infers the unit-of-work type from the handler annotation', () => {
    const factory = onIntegrationEvent(
      hired,
      async (payload, _envelope, _metadata, uow: Uow) => {
        await uow.getRepository('Person').create({ id: payload.personId });
      },
      { inbox: { consumer: 'payroll' } },
    );
    expect(typeof factory).toBe('function');
  });

  it('refuses a misspelled option key', () => {
    // @ts-expect-error — `inbx` is not an option.
    const definition: unknown = onIntegrationEvent(hired, () => {}, { queue: 'q', inbx: {} });
    // At runtime there is no `inbox`, so the plain form is returned.
    expect(typeof definition).toBe('object');
  });

  it('ReturnType and Parameters still read the legacy signature', () => {
    const returned: ReturnType<typeof onIntegrationEvent> = { topic: 't', handler: () => {} };
    const options: Parameters<typeof onIntegrationEvent>[2] = { queue: 'q' };
    expect(returned.topic).toBe('t');
    expect(options?.queue).toBe('q');
  });
});
