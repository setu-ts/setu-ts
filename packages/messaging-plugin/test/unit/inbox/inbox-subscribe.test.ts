/**
 * Resolving an inbox subscription (M108 §3.2, §3.4): the token, the foreign
 * provider, readiness, the `(consumer, topic)` registry, the queue default and
 * the consumer check at the call.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IServiceRegistry } from '@setu-ts/common';
import {
  InboxConsumerConflictError,
  InboxNotConfiguredError,
  InboxNotReadyError,
  onIntegrationEvent,
} from '../../../src/index.ts';
import { InboxService } from '../../../src/inbox/inbox-service.ts';
import { FakeInboxStore, hired, inboxRuntime, options } from '../../fixtures/inbox.ts';

/** A registry holding `entries`. */
function registry(entries: Record<string, unknown>): IServiceRegistry {
  return {
    has: (token: string) => Object.hasOwn(entries, token),
    get: <T>(token: string) => entries[token] as T,
  } as unknown as IServiceRegistry;
}

/** An active inbox service. */
function activeService(): InboxService {
  const service = new InboxService({
    runtime: inboxRuntime(),
    options: options(),
    logger: () => undefined,
  });
  service.activate(new FakeInboxStore());
  return service;
}

describe('inbox subscription resolution', () => {
  it('resolves to a definition on the topic, defaulting the queue to a hashed name', () => {
    const definition = onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'payroll' } })(
      registry({ inbox: activeService() }),
    );
    expect(definition.topic).toBe('people.hired.v1');
    // FNV-1a 64 over ["payroll","people.hired.v1"], computed independently.
    expect(definition.options).toEqual({ queue: 'inbox.ceb43f8aaeee103e' });
    expect(Object.keys(definition.options ?? {})).toEqual(['queue']);
  });

  it('gives one consumer a distinct default queue per topic', () => {
    const services = registry({ inbox: activeService() });
    const a = onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'payroll' } })(services);
    const b = onIntegrationEvent({ ...hired, topic: 'people.left.v1' }, () => {}, {
      inbox: { consumer: 'payroll' },
    })(services);
    expect(a.options?.queue).not.toBe(b.options?.queue);
    expect(b.options).toEqual({ queue: 'inbox.2b2a8963b3237cdb' });
  });

  it('keeps an explicit queue', () => {
    const definition = onIntegrationEvent(hired, () => {}, {
      queue: 'payroll-group',
      inbox: { consumer: 'payroll' },
    })(registry({ inbox: activeService() }));
    expect(definition.options).toEqual({ queue: 'payroll-group' });
  });

  it('resolves inbox.<instance> for a named messaging instance', () => {
    const factory = onIntegrationEvent(hired, () => {}, {
      inbox: { consumer: 'payroll', instance: 'billing' },
    });
    expect(() => factory(registry({ inbox: activeService() }))).toThrow("'inbox.billing'");
    expect(factory(registry({ 'inbox.billing': activeService() })).topic).toBe('people.hired.v1');
  });

  it('refuses an unregistered token and a provider it cannot drive', () => {
    const factory = onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'payroll' } });
    let missing: unknown;
    try {
      factory(registry({}));
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(InboxNotConfiguredError);
    expect((missing as InboxNotConfiguredError).reason).toBe('unregistered');
    for (const foreign of [{ parked: () => {} }, 'not-an-object']) {
      expect(() => factory(registry({ inbox: foreign }))).toThrow(InboxNotConfiguredError);
    }
  });

  it('refuses resolution before the store is verified, and after close', () => {
    const service = new InboxService({
      runtime: inboxRuntime(),
      options: options(),
      logger: () => undefined,
    });
    const factory = onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'payroll' } });
    expect(() => factory(registry({ inbox: service }))).toThrow(InboxNotReadyError);
    service.activate(new FakeInboxStore());
    service.close();
    expect(() => factory(registry({ inbox: service }))).toThrow('closed');
  });

  it('refuses a second (consumer, topic) pair, but not another consumer or topic', () => {
    const service = activeService();
    const services = registry({ inbox: service });
    onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'payroll' } })(services);
    expect(() => onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'payroll' } })(services))
      .toThrow(InboxConsumerConflictError);
    onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'billing' } })(services);
    const other = { ...hired, topic: 'people.left.v1' };
    onIntegrationEvent(other, () => {}, { inbox: { consumer: 'payroll' } })(services);
  });

  it('refuses a malformed consumer at the call, without echoing it', () => {
    for (const consumer of ['', ' x', 'a\u0000b', 'x'.repeat(129)]) {
      let thrown: unknown;
      try {
        onIntegrationEvent(hired, () => {}, { inbox: { consumer } });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      if (consumer.length > 0) expect((thrown as Error).message).not.toContain(consumer);
    }
  });

  it('refuses a malformed instance name at the call', () => {
    expect(() =>
      onIntegrationEvent(hired, () => {}, { inbox: { consumer: 'p', instance: 'Bad:Name' } })
    ).toThrow();
  });
});
