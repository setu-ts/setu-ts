/**
 * Contract tests for the M98j event-diagnostics types in `common`: the
 * exact key sets, the export consumer chain (barrel → service module →
 * token), and the teardown/disabled path of a conforming source.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  EventDiagnosticsRecord,
  EventDiagnosticsResponse,
  EventDiagnosticsSnapshot,
  IEventDiagnosticsSource,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
// The export-consumer check: importing the *values* through the barrel must
// type-check and resolve, so a dropped export cannot pass silently.
import * as common from '@setu-ts/common';

/** A record with exactly the nine committed keys. */
function record(): EventDiagnosticsRecord {
  return {
    alias: 'users',
    operation: 'publish',
    count: 1,
    started: 1,
    succeeded: 1,
    failed: 0,
    noSubscribers: 0,
    lastDurationMs: 2,
    ageMs: 1,
  };
}

/** A snapshot with exactly the five committed keys. */
function snapshot(): EventDiagnosticsSnapshot {
  return {
    state: 'ready',
    alias: 'bus',
    coverage: 'owned-instance',
    records: [record()],
    dropped: 0,
  };
}

/** A source with exactly one method. */
function source(): IEventDiagnosticsSource {
  return { snapshot: () => snapshot() };
}

describe('M98j common contracts', () => {
  it('exposes the token through CAPABILITIES with the committed kebab-case value', () => {
    expect(CAPABILITIES.EVENTS_DIAGNOSTICS).toEqual('event-diagnostics');
    expect(CAPABILITIES.EVENTS_DIAGNOSTICS).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it('exports the contract types as runtime-resolvable (type-level only is fine, but the token is a value)', () => {
    // The DTOs are type-only; the committed VALUE surface is the token and
    // the existing diagnostics exports. This compiles only when the barrel
    // still re-exports the diagnostics module.
    expect(typeof common.CAPABILITIES.EVENTS_DIAGNOSTICS).toEqual('string');
  });

  it('a conforming source answers a snapshot with exactly the committed keys', () => {
    const snap = source().snapshot();
    expect(Object.keys(snap).sort()).toEqual([
      'alias',
      'coverage',
      'dropped',
      'records',
      'state',
    ]);
    expect(Object.keys(snap.records[0]!).sort()).toEqual([
      'ageMs',
      'alias',
      'count',
      'failed',
      'lastDurationMs',
      'noSubscribers',
      'operation',
      'started',
      'succeeded',
    ]);
  });

  it('the disabled path: a null-alias snapshot with no records', () => {
    const disabled: EventDiagnosticsSnapshot = {
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    };
    expect(disabled.records).toEqual([]);
  });

  it('the response shape: version, instanceId, state, sources', () => {
    const response: EventDiagnosticsResponse = {
      version: 1,
      instanceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      state: 'ready',
      sources: [{ sourceId: 'e1', snapshot: snapshot() }],
    };
    expect(Object.keys(response).sort()).toEqual(['instanceId', 'sources', 'state', 'version']);
    expect(Object.keys(response.sources[0]!).sort()).toEqual(['snapshot', 'sourceId']);
  });

  it('teardown: a closed source answers disabled and hands out nothing further', () => {
    let closed = false;
    const closing: IEventDiagnosticsSource = {
      snapshot: () =>
        closed
          ? {
            state: 'disabled',
            alias: null,
            coverage: 'owned-instance',
            records: [],
            dropped: 0,
          }
          : snapshot(),
    };
    expect(closing.snapshot().state).toEqual('ready');
    closed = true;
    expect(closing.snapshot().state).toEqual('disabled');
  });
});
