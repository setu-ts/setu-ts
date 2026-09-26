import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { DiagnosticsEvent } from '@setu-ts/common';

import { DiagnosticsCollector } from '../../src/diagnostics/collector.ts';
import { encodedEventByteLength, MAX_EVENT_BYTES } from '../../src/diagnostics/buffer.ts';
import { compileLabelAllowlists } from '../../src/diagnostics/projection.ts';

function collectorWith(
  labels?: Parameters<typeof compileLabelAllowlists>[0],
): DiagnosticsCollector {
  return new DiagnosticsCollector(compileLabelAllowlists(labels ?? {}));
}

describe('DiagnosticsCollector — snapshot contract', () => {
  it('reports created state with null instance and null timings before runtime', () => {
    const collector = collectorWith();
    const snapshot = collector.snapshot();
    expect(snapshot).toEqual({
      version: 1,
      instanceId: null,
      state: 'created',
      failureCode: null,
      nodes: [],
      edges: [],
      truncated: false,
      droppedEvents: 0,
    });
    collector.beginOperation();
    collector.endRequestOperation({}, { outcome: 'ok', statusCode: 200 });
    collector.observeHandlerStage({
      parentOperationId: 'op1',
      stage: 'handler',
      nodeId: null,
      outcome: 'ok',
      startedAtMs: null,
      durationMs: null,
    });
    const batch = collector.read(0);
    expect(batch.events.every((event) => event.atMs === null && event.durationMs === null))
      .toBe(true);
  });

  it('deep-freezes snapshots and batches, and caches until a mutation', () => {
    const collector = collectorWith();
    const first = collector.snapshot();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nodes)).toBe(true);
    expect(collector.snapshot()).toBe(first);
    collector.markStarting();
    const second = collector.snapshot();
    expect(second).not.toBe(first);
    expect(second.state).toBe('starting');
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('walks the state machine and reports the bounded failure codes', () => {
    const collector = collectorWith();
    collector.markStarting();
    collector.markRunning();
    collector.markStopping();
    expect(collector.snapshot().state).toBe('stopping');
    collector.markClosed(false);
    const closed = collector.snapshot();
    expect(closed.state).toBe('closed');
    expect(closed.failureCode).toBeNull();
    // Terminal: later transitions are ignored.
    collector.markStarting();
    expect(collector.snapshot().state).toBe('closed');
  });

  it('assigns the instance UUID only at runtime initialization', () => {
    const collector = collectorWith();
    expect(collector.snapshot().instanceId).toBeNull();
    collector.initializeRuntime({ uuid: () => 'uuid-1', hrtime: () => 1_000 }, undefined);
    expect(collector.snapshot().instanceId).toBe('uuid-1');
    // Timings become offsets from the recorded origin.
    collector.markStarting();
    const operation = collector.beginOperation();
    collector.observeLifecycleEvent(operation, 'init', null, 'ok');
    const event = collector.read(0).events[0]!;
    expect(event.stage).toBe('init');
    // The fake clock is constant at its origin, so the offset is exactly 0.
    expect(event.atMs).toBe(0);
  });

  it('treats a throwing runtime clock as unavailable rather than fatal', () => {
    const collector = collectorWith();
    collector.initializeRuntime(
      {
        uuid: () => 'uuid-2',
        hrtime(): number {
          throw new Error('clock gone');
        },
      },
      undefined,
    );
    expect(collector.monotonicMs()).toBeNull();
    const operation = collector.beginOperation();
    collector.observeLifecycleEvent(operation, 'init', null, 'ok');
    const event = collector.read(0).events[0]!;
    expect(event.atMs).toBeNull();
    expect(event.durationMs).toBeNull();
  });

  it('clears retained buffers at terminal failure while keeping counters', () => {
    const collector = collectorWith({ labels: { plugins: ['api'] } });
    collector.pluginRegistered({
      name: 'api',
      version: '1.0.0',
      provides: ['db'],
      requires: [],
      optionalDependencies: [],
      consumes: [],
    });
    expect(collector.snapshot().nodes.length).toBeGreaterThan(0);
    collector.markStarting();
    collector.markStartupFailed();
    const snapshot = collector.snapshot();
    expect(snapshot.state).toBe('failed');
    expect(snapshot.failureCode).toBe('startup-failed');
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    // A second failure marker cannot resurrect or double-apply.
    collector.markClosed(true);
    expect(collector.snapshot().state).toBe('failed');
    expect(collector.snapshot().failureCode).toBe('startup-failed');
  });

  it('a NEW start after a failed start resets the reader (the kernel supports retry)', () => {
    const collector = collectorWith({ labels: { plugins: ['api'] } });
    collector.markStarting();
    collector.pluginRegistered({
      name: 'api',
      version: '1.0.0',
      provides: ['db'],
      requires: [],
      optionalDependencies: [],
      consumes: [],
    });
    collector.markStartupFailed();
    expect(collector.snapshot().state).toBe('failed');

    // The kernel's supported retry: unregister + start() again. markStarting
    // resets the latch, clears the failure code, and drops the failed
    // attempt's (already-cleared) retained metadata.
    collector.markStarting();
    const retried = collector.snapshot();
    expect(retried.state).toBe('starting');
    expect(retried.failureCode).toBeNull();
    expect(retried.nodes).toEqual([]);
    // The retry collects normally and reaches running.
    collector.pluginRegistered({
      name: 'api',
      version: '1.0.0',
      provides: ['db'],
      requires: [],
      optionalDependencies: [],
      consumes: [],
    });
    collector.markRunning();
    const running = collector.snapshot();
    expect(running.state).toBe('running');
    expect(running.nodes.length).toBeGreaterThan(0);
    // A SECOND failure still terminates, and markClosed from failed is
    // still ignored (only a new markStarting may leave failed).
    collector.markStartupFailed();
    expect(collector.snapshot().state).toBe('failed');
    collector.markClosed(false);
    expect(collector.snapshot().state).toBe('failed');
    expect(collector.snapshot().failureCode).toBe('startup-failed');
  });

  it('closed reads answer an empty, closed batch without throwing', () => {
    const collector = collectorWith();
    collector.markRunning();
    const operation = collector.beginOperation();
    collector.observeLifecycleEvent(operation, 'bootstrap', null, 'ok');
    collector.markClosed(false);
    const batch = collector.read(0);
    expect(batch.closed).toBe(true);
    expect(batch.events).toEqual([]);
    expect(batch.next).toBe(0);
    // A cursor that was valid before shutdown still reads as closed, not thrown.
    expect(collector.read(500).closed).toBe(true);
  });
});

describe('DiagnosticsCollector — events', () => {
  it('reads are non-destructive and cursors advance by batch', () => {
    const collector = collectorWith();
    for (let i = 0; i < 5; i++) {
      collector.observeLifecycleEvent(collector.beginOperation(), 'init', null, 'ok');
    }
    const pageOne = collector.read(0, 2);
    expect(pageOne.events.length).toBe(2);
    expect(pageOne.next).toBe(2);
    expect(pageOne.lost).toBe(0);
    // Same cursor, same page: a reader never steals from another.
    expect(collector.read(0, 2).events.length).toBe(2);
    const pageTwo = collector.read(pageOne.next, 2);
    expect(pageTwo.events.length).toBe(2);
    expect(pageTwo.events[0]!.sequence).toBe(3);
  });

  it('reports evicted sequences as lost', () => {
    const collector = collectorWith();
    const operation = collector.beginOperation();
    for (let i = 0; i < 1030; i++) {
      collector.observeLifecycleEvent(collector.beginOperation(), 'init', null, 'ok');
    }
    void operation;
    const snapshot = collector.snapshot();
    expect(snapshot.droppedEvents).toBe(0);
    const first = collector.read(0, 1);
    // The ring holds 1,024 of 1,030 events: 6 evicted before the oldest.
    expect(first.lost).toBe(6);
  });

  it('drops oversized events whole and counts them', () => {
    const collector = collectorWith();
    // An adversarial CALLER string is the one way a fixed-shape record can
    // blow the byte cap — the defense exists for exactly this input.
    collector.observeHandlerStage({
      parentOperationId: 'x'.repeat(MAX_EVENT_BYTES),
      stage: 'handler',
      nodeId: null,
      outcome: 'ok',
      startedAtMs: null,
      durationMs: null,
    });
    expect(collector.snapshot().droppedEvents).toBe(1);
    // The oversized event consumed no sequence: the next record is sequence 1.
    collector.observeHandlerStage({
      parentOperationId: 'op1',
      stage: 'handler',
      nodeId: null,
      outcome: 'ok',
      startedAtMs: null,
      durationMs: null,
    });
    const batch = collector.read(0);
    expect(batch.events.length).toBe(1);
    expect(batch.events[0]!.sequence).toBe(1);
    // Sanity: the cap check is real.
    expect(encodedEventByteLength(batch.events[0]!)).toBeLessThan(MAX_EVENT_BYTES);
  });

  it('disables further event capture after an event-capture failure', () => {
    const collector = collectorWith();
    collector.safeObserve('event', () => {
      throw new Error('capture blew up');
    });
    expect(collector.snapshot().droppedEvents).toBe(1);
    collector.observeHandlerStage({
      parentOperationId: 'op0',
      stage: 'handler',
      nodeId: null,
      outcome: 'ok',
      startedAtMs: null,
      durationMs: null,
    });
    expect(collector.read(0).events.length).toBe(0);
  });

  it('marks topology truncated after a topology-capture failure', () => {
    const collector = collectorWith();
    collector.safeObserve('topology', () => {
      throw new Error('topology blew up');
    });
    const snapshot = collector.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes).toEqual([]);
  });

  it('carries validated trace identifiers only, reading an already-resolved service', () => {
    const collector = collectorWith();
    let active: { traceId: string; spanId: string } | undefined = {
      traceId: 'a'.repeat(32).replace(/a/g, '1'),
      spanId: 'b'.repeat(16).replace(/b/g, '2'),
    };
    let reads = 0;
    collector.initializeRuntime({ uuid: () => 'u', hrtime: () => 0 }, () => {
      reads++;
      return { activeSpanContext: () => active };
    });
    collector.markRunning();
    const ctxOne: object = {};
    collector.beginRequestOperation(ctxOne);
    collector.endRequestOperation(ctxOne, { outcome: 'ok', statusCode: 200 });
    const event = collector.read(0).events[0]!;
    expect(event.traceId).toBe('1'.repeat(32));
    expect(event.spanId).toBe('2'.repeat(16));
    expect(reads).toBe(1);

    // All-zero W3C ids mean invalid, not anonymous.
    active = { traceId: '0'.repeat(32), spanId: '0'.repeat(16) };
    const ctxTwo: object = {};
    collector.beginRequestOperation(ctxTwo);
    collector.endRequestOperation(ctxTwo, { outcome: 'ok', statusCode: 200 });
    const invalid = collector.read(1).events[0]!;
    expect(invalid.traceId).toBeUndefined();
    expect(invalid.spanId).toBeUndefined();
  });

  it('reports every unreadable telemetry shape as absence, never a fabricated id', () => {
    // Each arm needs its OWN collector: `initializeRuntime` is idempotent, so
    // re-calling it on a collector that already has a reader installs
    // nothing — an earlier version of this suite did exactly that and its
    // "a throwing read is reported as absence" case therefore re-ran the
    // PREVIOUS reader and asserted nothing about the catch.
    const record = (
      reader: (() => { activeSpanContext?(): unknown } | undefined) | undefined,
    ): DiagnosticsEvent => {
      const collector = collectorWith();
      collector.initializeRuntime(
        { uuid: () => 'u', hrtime: () => 0 },
        reader as never,
      );
      const ctx: object = {};
      collector.beginRequestOperation(ctx);
      collector.endRequestOperation(ctx, { outcome: 'ok', statusCode: 200 });
      return collector.read(0).events[0]!;
    };

    // The reader itself throws — the capability was registered but resolving
    // its cached instance failed.
    const readerThrew = record(() => {
      throw new Error('telemetry gone');
    });
    expect(readerThrew.traceId).toBeUndefined();
    expect(readerThrew.spanId).toBeUndefined();

    // No telemetry is registered at all.
    expect(record(() => undefined).traceId).toBeUndefined();

    // A service that predates the accessor carries no `activeSpanContext`.
    expect(record(() => ({})).traceId).toBeUndefined();

    // A registered service with no ACTIVE span answers `undefined` — the
    // ordinary case for a request outside any trace.
    expect(record(() => ({ activeSpanContext: () => undefined })).traceId).toBeUndefined();

    // The accessor itself throws.
    const accessorThrew = record(() => ({
      activeSpanContext: () => {
        throw new Error('span read exploded');
      },
    }));
    expect(accessorThrew.traceId).toBeUndefined();
    expect(accessorThrew.spanId).toBeUndefined();
  });
});

describe('DiagnosticsCollector — topology', () => {
  it('projects labels only through the allowlists and bounds versions', () => {
    const collector = collectorWith({
      labels: {
        plugins: ['api'],
        capabilities: ['database'],
        routes: ['GET /users'],
        middleware: ['auth'],
      },
    });
    collector.pluginRegistered({
      name: 'api',
      version: 'not-semver',
      provides: ['database', 'secret-capability'],
      requires: ['runtime'],
      optionalDependencies: [],
      consumes: [],
    });
    collector.pluginRegistered({
      name: 'unlisted',
      version: '1.0.0',
      provides: [],
      requires: [],
      optionalDependencies: [],
      consumes: [],
    });
    const snapshot = collector.snapshot();
    const api = snapshot.nodes.find((node) => node.label === 'api');
    expect(api?.kind).toBe('plugin');
    expect(api?.version).toBeUndefined();
    const unlisted = snapshot.nodes.find((node) => node.kind === 'plugin' && !node.label);
    expect(unlisted).toBeDefined();
    expect(
      snapshot.nodes.some((node) => node.label === 'secret-capability'),
    ).toBe(false);
    const database = snapshot.nodes.find((node) => node.label === 'database');
    expect(database?.registered).toBe(false);
  });

  it('marks capabilities registered via registry events and owns them to the plugin', () => {
    const collector = collectorWith({
      labels: { plugins: ['api'], capabilities: ['db', 'indicator'] },
    });
    collector.pluginRegistered({
      name: 'api',
      version: '1.0.0',
      provides: ['db'],
      requires: [],
      optionalDependencies: [],
      consumes: [],
    });
    collector.capabilityRegistrationObserved({ kind: 'register-single', token: 'db' }, 'api');
    collector.capabilityRegistrationObserved({ kind: 'register-multi', token: 'indicator' }, 'api');
    const snapshot = collector.snapshot();
    expect(snapshot.nodes.find((node) => node.label === 'db')?.registered).toBe(true);
    // A capability never declared by a plugin is created on its registration.
    const indicator = snapshot.nodes.find((node) => node.label === 'indicator');
    expect(indicator?.registered).toBe(true);
    expect(
      snapshot.edges.some((edge) => edge.kind === 'owns' && edge.from!.length > 0),
    ).toBe(true);
    // Unregister reports the registration as no longer present.
    collector.capabilityRegistrationObserved({ kind: 'unregister', token: 'db' }, 'api');
    expect(collector.snapshot().nodes.find((node) => node.label === 'db')?.registered).toBe(false);
    // An owner that captured no node (application code) attributes nothing.
    collector.capabilityRegistrationObserved(
      { kind: 'register-single', token: 'orphan' },
      undefined,
    );
    expect(
      collector.snapshot().edges.filter((edge) => edge.kind === 'owns').length,
    ).toBe(2);
  });

  it('captures routes with projected methods, positions, and middleware stages', () => {
    const collector = collectorWith({ labels: { routes: ['GET /users'] } });
    collector.pluginRegistered({
      name: 'api',
      version: '1.0.0',
      provides: [],
      requires: [],
      optionalDependencies: [],
      consumes: [],
    });
    const routeNodeId = collector.routeRegistered({
      kind: 'register',
      entryIndex: 0,
      method: 'GET',
      pattern: 'GET /users',
      owner: 'api',
      middlewareCount: 2,
    });
    collector.routeRegistered({
      kind: 'register',
      entryIndex: 1,
      method: 'TRACE',
      pattern: 'TRACE /x',
      owner: undefined,
      middlewareCount: 0,
    });
    const snapshot = collector.snapshot();
    const route = snapshot.nodes.find((node) => node.id === routeNodeId);
    expect(route?.method).toBe('GET');
    expect(route?.label).toBe('GET /users');
    // The unsupported method is omitted, never widened.
    const traceRoute = snapshot.nodes.find((node) =>
      node.label === undefined && node.kind === 'route'
    );
    expect(traceRoute?.method).toBeUndefined();
    // Route middleware stages carry only id and position.
    const stages = snapshot.nodes.filter((node) => node.kind === 'middleware');
    expect(stages.length).toBe(2);
    expect(stages.map((stage) => stage.position).sort()).toEqual([1, 2]);
    expect(stages.every((stage) => stage.label === undefined)).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === 'owns')).toBe(true);
    // Dispatch resolves the route node by its entry index.
    expect(collector.routeNodeIdOf(0)).toBe(routeNodeId);
    expect(collector.routeNodeIdOf(99)).toBeUndefined();
  });

  it('captures the compiled global pipeline in execution order', () => {
    const collector = collectorWith({ labels: { middleware: ['auth'] } });
    collector.middlewareCompiled([
      { name: 'auth', priority: 20, position: 1 },
      { name: '<anonymous-0>', priority: 500, position: 2 },
    ]);
    const snapshot = collector.snapshot();
    const auth = snapshot.nodes.find((node) => node.label === 'auth');
    expect(auth?.priority).toBe(20);
    expect(auth?.position).toBe(1);
    const anonymous = snapshot.nodes.find((node) =>
      node.label === undefined && node.kind === 'middleware'
    );
    expect(anonymous?.position).toBe(2);
  });

  it('stops adding nodes and edges at the fixed v1 limits', () => {
    const collector = collectorWith();
    for (let i = 0; i < 1_100; i++) {
      collector.pluginRegistered({
        name: `plugin-${i}`,
        version: '1.0.0',
        provides: [`cap-${i}`],
        requires: [],
        optionalDependencies: [],
        consumes: [],
      });
    }
    const snapshot = collector.snapshot();
    expect(snapshot.nodes.length).toBe(1_024);
    expect(snapshot.truncated).toBe(true);
    // Every edge kept names two retained nodes: no dangling endpoints.
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    expect(snapshot.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)))
      .toBe(true);
  });

  it('snapshot cache survives request events but rebuilds on drops', () => {
    const collector = collectorWith();
    const first = collector.snapshot();
    const ctx: object = {};
    collector.beginRequestOperation(ctx);
    collector.endRequestOperation(ctx, { outcome: 'ok', statusCode: 200 });
    expect(collector.read(0).events.length).toBe(1);
    expect(collector.snapshot()).toBe(first);
    collector.safeObserve('event', () => {
      throw new Error('boom');
    });
    expect(collector.snapshot()).not.toBe(first);
  });

  it('events read from the ring are frozen records, not live handles', () => {
    const collector = collectorWith();
    collector.observeLifecycleEvent(collector.beginOperation(), 'init', null, 'ok');
    const event: DiagnosticsEvent = collector.read(0).events[0]!;
    expect(Object.isFrozen(event)).toBe(true);
  });
});

describe('DiagnosticsCollector — sequence numbering across a retried start', () => {
  /** Emits one handler record. */
  function emit(collector: DiagnosticsCollector): void {
    collector.observeHandlerStage({
      parentOperationId: 'op1',
      stage: 'handler',
      nodeId: null,
      outcome: 'ok',
      startedAtMs: null,
      durationMs: null,
    });
  }

  it('never reuses a sequence number, so a cursor from the failed attempt stays valid', () => {
    const collector = collectorWith();
    collector.markStarting();
    for (let i = 0; i < 3; i++) emit(collector);
    // A reader polled the failed attempt and holds cursor 3.
    const held = collector.read(0).next;
    expect(held).toBe(3);

    collector.markStartupFailed();
    // The failed attempt's records are discarded, not readable.
    expect(collector.read(0).events).toEqual([]);
    collector.markStarting();
    emit(collector);
    emit(collector);

    // The held cursor is not "beyond the current sequence", and the retry's
    // records are neither renumbered from 1 nor silently skipped.
    const resumed = collector.read(held);
    expect(resumed.events.map((event) => event.sequence)).toEqual([4, 5]);
    expect(resumed.lost).toBe(0);
    // A reader starting fresh sees the discarded range as lost.
    const fresh = collector.read(0);
    expect(fresh.events[0].sequence).toBe(4);
    expect(fresh.lost).toBe(3);
  });
});

describe('DiagnosticsCollector — non-finite application numbers are omitted', () => {
  it('omits a non-finite middleware priority and keeps every finite one', () => {
    const collector = collectorWith();
    collector.middlewareCompiled([
      { name: 'a', priority: Number.NaN, position: 1 },
      { name: 'b', priority: Number.POSITIVE_INFINITY, position: 2 },
      { name: 'c', priority: -2.5, position: 3 },
    ]);
    const nodes = collector.snapshot().nodes;
    expect(nodes.map((node) => Object.hasOwn(node, 'priority'))).toEqual([false, false, true]);
    expect(nodes[2].priority).toBe(-2.5);
    // JSON would otherwise carry `null` in a `number` field.
    expect(JSON.stringify(collector.snapshot())).not.toContain('null,"position"');
  });

  it('omits a non-finite status code and keeps an out-of-range finite one', () => {
    const collector = collectorWith();
    for (const statusCode of [Number.NaN, 1000]) {
      collector.observeHandlerStage({
        parentOperationId: 'op1',
        stage: 'handler',
        nodeId: null,
        outcome: 'ok',
        startedAtMs: null,
        durationMs: null,
        statusCode,
      });
    }
    const events = collector.read(0).events;
    expect(Object.hasOwn(events[0], 'statusCode')).toBe(false);
    expect(events[1].statusCode).toBe(1000);
  });
});
