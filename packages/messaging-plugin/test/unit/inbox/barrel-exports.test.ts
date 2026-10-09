/**
 * The inbox's public surface (M108 §4): every symbol is exported from the
 * BARREL — the types checked at compile time against the barrel, never the
 * concrete module (the M56 lesson) — and the internals stay unexported.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as messaging from '../../../src/index.ts';
import type {
  IInbox,
  InboxOptions,
  InboxPurgeOptions,
  InboxReleaseResult,
  InboxStoreEntry,
  IntegrationEventInboxHandler,
  IntegrationEventInboxOptions,
  IntegrationEventSubscribeOptions,
  ParkedInboxEntry,
} from '../../../src/index.ts';

// Compile-time: each exported type names its real shape.
const purge: InboxPurgeOptions = { schedule: false, intervalMs: 1, batch: 1 };
const inboxOption: IntegrationEventInboxOptions = { consumer: 'c', instance: 'i' };
const subscribeOptions: IntegrationEventSubscribeOptions = { queue: 'q', inbox: inboxOption };
const entry: ParkedInboxEntry = {
  rowId: 'r',
  consumer: 'c',
  topic: 't',
  attempts: 1,
  updatedAt: 1,
};
const result: InboxReleaseResult = { topic: 't' };
const handler: IntegrationEventInboxHandler<number, string> = (_p, _e, _m, scope) => {
  void scope.length;
};
type StoreOf<T> = T extends { readonly store: infer S } ? S : never;
const entryIsStoreOption: InboxStoreEntry extends StoreOf<InboxOptions> ? true : false = true;
type ReleaseOf<T> = T extends { release(...args: never[]): Promise<infer R> } ? R : never;
const releaseAnswers: ReleaseOf<IInbox> extends InboxReleaseResult ? true : false = true;

describe('inbox barrel exports', () => {
  it('exports the six inbox error classes as constructors', () => {
    const errors = [
      new messaging.InboxConsumerConflictError('c', 't'),
      new messaging.InboxNotConfiguredError('inbox', 'unregistered'),
      new messaging.InboxNotReadyError('not-started'),
      new messaging.InboxPurgeUnscheduledError(),
      new messaging.InboxRowStateError('missing'),
      new messaging.InboxStoreVerifyTimeoutError(5),
    ];
    expect(errors.map((error) => error.name)).toEqual([
      'InboxConsumerConflictError',
      'InboxNotConfiguredError',
      'InboxNotReadyError',
      'InboxPurgeUnscheduledError',
      'InboxRowStateError',
      'InboxStoreVerifyTimeoutError',
    ]);
  });

  it('keeps the inbox internals out of the barrel', () => {
    for (
      const internal of [
        'InboxService',
        'inboxServiceOf',
        'createInboxHealthIndicator',
        'resolveInboxOptions',
        'deriveInboxIds',
        'idsFromMarker',
        'isMarkerId',
        'parseEnvelopeData',
      ]
    ) {
      expect(internal in messaging).toBe(false);
    }
  });

  it('the compile-time witnesses hold', () => {
    expect([purge, subscribeOptions, entry, result, handler]).toHaveLength(5);
    expect([entryIsStoreOption, releaseAnswers]).toEqual([true, true]);
  });
});
