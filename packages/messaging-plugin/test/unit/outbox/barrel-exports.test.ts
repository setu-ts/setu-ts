/**
 * The outbox's public surface (M107 §4): every §4 `messaging-plugin` symbol is
 * exported from the BARREL — the types checked at compile time against the
 * barrel, never the concrete module (the M56 lesson: a re-export file is
 * "covered" merely by being loaded) — and the internals stay unexported.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as messaging from '../../../src/index.ts';
import type {
  IOutbox,
  OutboxCommonOptions,
  OutboxHealthOptions,
  OutboxOptions,
  OutboxRelayOptions,
  OutboxStoreEntry,
  OutboxSweepResult,
  OutboxWriteInput,
} from '../../../src/index.ts';

// Compile-time: each exported type names its real shape. A barrel that
// dropped one fails `deno check` on these lines.
const relay: OutboxRelayOptions = { schedule: false, intervalMs: 1000 };
const health: OutboxHealthOptions = { degradedAfterMs: 1 };
const common: OutboxCommonOptions = { relay, health, purgeBatch: 1 };
const sweepResult: OutboxSweepResult = {
  origin: 'scheduled',
  scanned: 0,
  published: 0,
  failures: 0,
  poisoned: 0,
  endedBy: 'complete',
};
const writeInput: OutboxWriteInput = { tenantId: 't-1' };
type StoreOf<T> = T extends { readonly store: infer S } ? S : never;
const entryIsStoreOption: OutboxStoreEntry extends StoreOf<OutboxOptions> ? true : false = true;
type DispatchOf<T> = T extends { dispatch(): infer R } ? R : never;
const dispatchReturnsVoid: DispatchOf<IOutbox> extends void ? true : false = true;

describe('outbox barrel exports', () => {
  it('exports the five outbox error classes as constructors', () => {
    const errors = [
      messaging.OutboxEnvelopeTooLargeError,
      messaging.OutboxNotReadyError,
      messaging.OutboxRelayUnscheduledError,
      messaging.OutboxRowStateError,
      messaging.OutboxUnknownTenantError,
    ];
    for (const ctor of errors) expect(typeof ctor).toBe('function');
    expect(new messaging.OutboxRelayUnscheduledError().name).toBe('OutboxRelayUnscheduledError');
  });

  it('keeps the outbox internals out of the barrel', () => {
    for (
      const internal of [
        'OutboxService',
        'OutboxCollector',
        'createOutboxHealthIndicator',
        'resolveOutboxOptions',
        'boundedCall',
        'sweepStore',
        'SweepBudget',
        'PositionClock',
        'encodeOutboxRecord',
        'decodeOutboxRecord',
      ]
    ) {
      expect(internal in messaging).toBe(false);
    }
  });

  it('the compile-time witnesses hold', () => {
    expect(common.relay).toBe(relay);
    expect(sweepResult.endedBy).toBe('complete');
    expect(writeInput.tenantId).toBe('t-1');
    expect(entryIsStoreOption).toBe(true);
    expect(dispatchReturnsVoid).toBe(true);
  });
});
