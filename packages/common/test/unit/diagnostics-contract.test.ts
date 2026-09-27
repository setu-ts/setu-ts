import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type {
  ConfigDiagnosticsSnapshot,
  ConfigProvenanceEntry,
  DiagnosticsBatch,
  DiagnosticsEvent,
  HealthDiagnosticsObservation,
  HealthDiagnosticsSnapshot,
  IConfigDiagnosticsSource,
  IDiagnosticsSource,
  IHealthDiagnosticsSource,
  IPlugin,
  IPluginContext,
  IQueueDiagnosticsSource,
  ITraceDiagnosticsSource,
  QueueAttemptObservation,
  QueueDiagnosticsBatch,
  QueueDiagnosticsSourceBatch,
  QueueSourceAttemptObservation,
  TraceCoverage,
  TraceDiagnosticsBatch,
  TraceSourceState,
} from '@setu-ts/common';
import type { IApplication } from '@setu-ts/common';

/**
 * A MINIMAL structural `IApplication` of the pre-diagnostics shape — exactly
 * what a third-party implementation written before M98a looked like. The
 * optional `diagnostics` member must not force this type to change.
 */
interface LegacyApplication {
  readonly name: string;
  start(): Promise<void>;
}

describe('diagnostics type contracts', () => {
  it('accepts a structural application that predates diagnostics', () => {
    // Compiles only because `IApplication.diagnostics` is optional AND allows
    // an explicitly-undefined answer — the disabled kernel's getter shape.
    const legacy: LegacyApplication = { name: 'old', start: () => Promise.resolve() };
    const app: IApplication = {
      router: {} as IApplication['router'],
      middleware: {} as IApplication['middleware'],
      services: {} as IApplication['services'],
      register: () => app as unknown as IApplication,
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      fetch: () => Promise.resolve(new Response(null)),
    };
    expect(legacy.name).toBe('old');
    expect(app.diagnostics).toBeUndefined();
  });

  it('a consumer compiles against the reader surface and the frozen DTOs', () => {
    const source: IDiagnosticsSource = {
      snapshot: () => ({
        version: 1,
        instanceId: null,
        state: 'created',
        failureCode: null,
        nodes: [],
        edges: [],
        truncated: false,
        droppedEvents: 0,
      }),
      read: () => ({
        version: 1,
        instanceId: null,
        events: [],
        next: 0,
        lost: 0,
        closed: true,
      }),
    };
    const snapshot = source.snapshot();
    const batch: DiagnosticsBatch = source.read(0);
    expect(snapshot.version).toBe(1);
    expect(batch.closed).toBe(true);
    // A consumer holding the reader cannot register a callback or write —
    // the surface carries only the two read methods.
    expect(Object.keys(source).sort()).toEqual(['read', 'snapshot']);
  });

  it('event fields carry the documented vocabulary and null timing shape', () => {
    const event: DiagnosticsEvent = {
      sequence: 1,
      operationId: 'op1',
      parentOperationId: null,
      kind: 'lifecycle',
      stage: 'resolve',
      nodeId: null,
      outcome: 'ok',
      atMs: null,
      durationMs: null,
    };
    expect(event.atMs).toBeNull();
    expect(event.durationMs).toBeNull();
    expect(event.parentOperationId).toBeNull();
  });

  it('the plugin contract still declares only the committed edge families', () => {
    // Guards the boundary claim: declared edges are not observed calls. The
    // four declared families are unchanged and no diagnostics field was added
    // to the plugin contract in this change.
    const plugin: IPlugin = {
      name: 'p',
      version: '1.0.0',
      dependencies: ['runtime'],
      optionalDependencies: ['logger'],
      provides: ['thing'],
      consumes: ['other'],
      register(_ctx: IPluginContext) {},
    };
    expect(plugin.dependencies).toEqual(['runtime']);
    expect(plugin.optionalDependencies).toEqual(['logger']);
    expect(plugin.provides).toEqual(['thing']);
    expect(plugin.consumes).toEqual(['other']);
    expect(Object.hasOwn(plugin, 'diagnostics')).toBe(false);
  });
});

describe('health diagnostics type contracts (M98d)', () => {
  it('exposes the HEALTH_DIAGNOSTICS capability token', () => {
    expect(CAPABILITIES.HEALTH_DIAGNOSTICS).toBe('health-diagnostics');
    // Distinct from the health token itself.
    expect(CAPABILITIES.HEALTH_DIAGNOSTICS).not.toBe(CAPABILITIES.HEALTH);
  });

  it('a consumer compiles against the health source surface and the frozen DTO', () => {
    const reported: HealthDiagnosticsObservation = {
      indicatorAlias: 'database',
      status: 'up',
      state: 'reported',
      latencyMs: 3,
      ageMs: 12,
      origin: 'application',
    };
    const neverObserved: HealthDiagnosticsObservation = {
      indicatorAlias: 'cache',
      state: 'never-observed',
      latencyMs: null,
      ageMs: null,
      origin: 'scheduled',
    };
    const source: IHealthDiagnosticsSource = {
      snapshot: (instanceId) => ({
        version: 1,
        instanceId,
        state: 'ready',
        observations: [reported, neverObserved],
        truncated: false,
        droppedObservations: 0,
      }),
    };
    const snapshot: HealthDiagnosticsSnapshot = source.snapshot('instance-1');
    expect(snapshot.version).toBe(1);
    expect(snapshot.instanceId).toBe('instance-1');
    expect(snapshot.observations).toHaveLength(2);
    // The source surface carries only the synchronous read method.
    expect(Object.keys(source).sort()).toEqual(['snapshot']);
  });

  it('the observation DTO admits no data, error text, or absolute time', () => {
    // Compile-time: the exact member set is the minimization contract. Adding
    // a `data`, `error`, or `timestamp` member here would be a type error.
    const observation: HealthDiagnosticsObservation = {
      indicatorAlias: 'database',
      state: 'failed',
      latencyMs: 5,
      ageMs: 5,
      origin: 'application',
    };
    expect(Object.keys(observation).sort()).toEqual(
      ['ageMs', 'indicatorAlias', 'latencyMs', 'origin', 'state'],
    );
    // `status` is present only for a reported observation.
    expect('status' in observation).toBe(false);
  });
});

describe('configuration provenance contracts (M98e)', () => {
  it('the token is a valid eager capability and the source is synchronous with one method', () => {
    expect(CAPABILITIES.CONFIG_DIAGNOSTICS).toEqual('config-diagnostics');
    const source: IConfigDiagnosticsSource = {
      snapshot(instanceId: string): ConfigDiagnosticsSnapshot {
        return {
          version: 1,
          instanceId,
          state: 'ready',
          entries: [],
          truncated: false,
          droppedEntries: 0,
        };
      },
    };
    expect(Object.keys(source).sort()).toEqual(['snapshot']);
  });

  it('the provenance entry admits no value, hash, length, or path field', () => {
    // Compile-time: the exact member set is the minimization contract. A
    // `value`, `valueHash`, `valueLength`, or `path` member here would be a
    // type error.
    const entry: ConfigProvenanceEntry = {
      keyAlias: 'port',
      origin: 'environment',
      overriddenSourceAliases: ['dotenv'],
      expanded: false,
      referenceAliases: [],
      schemaEffect: 'validated',
    };
    expect(Object.keys(entry).sort()).toEqual([
      'expanded',
      'keyAlias',
      'origin',
      'overriddenSourceAliases',
      'referenceAliases',
      'schemaEffect',
    ]);
    // `sourceAlias` is optional and file-only by contract.
    expect('sourceAlias' in entry).toBe(false);
    const fileEntry: ConfigProvenanceEntry = {
      keyAlias: 'host',
      origin: 'file',
      sourceAlias: 'dotenv',
      overriddenSourceAliases: [],
      expanded: true,
      referenceAliases: ['port'],
      schemaEffect: 'not-configured',
    };
    expect(fileEntry.sourceAlias).toEqual('dotenv');
  });

  it('the snapshot carries exactly the fixed members', () => {
    const snapshot: ConfigDiagnosticsSnapshot = {
      version: 1,
      instanceId: 'i',
      state: 'no-data',
      entries: [],
      truncated: false,
      droppedEntries: 0,
    };
    expect(Object.keys(snapshot).sort()).toEqual([
      'droppedEntries',
      'entries',
      'instanceId',
      'state',
      'truncated',
      'version',
    ]);
  });
});

describe('queue diagnostics type contracts (M98f)', () => {
  it('exposes the QUEUE_DIAGNOSTICS capability token, distinct from the queue token', () => {
    expect(CAPABILITIES.QUEUE_DIAGNOSTICS).toBe('queue-diagnostics');
    expect(CAPABILITIES.QUEUE_DIAGNOSTICS).not.toBe(CAPABILITIES.QUEUE);
  });

  it('a source compiles against the synchronous paged read and the source batch', () => {
    const attempt: QueueSourceAttemptObservation = {
      sequence: 1,
      queueAlias: 'emails',
      jobAlias: 'j1',
      attempt: 1,
      durationMs: 3,
      outcome: 'completed',
      settlement: 'acknowledged',
      ageMs: 4,
    };
    const source: IQueueDiagnosticsSource = {
      read: (after) => ({
        version: 1,
        state: 'ready',
        instanceAlias: 'mailer',
        depthCoverage: 'unavailable',
        failure: 'none',
        attempts: [attempt],
        depths: [],
        next: after + 1,
        lost: 0,
        closed: false,
        droppedAttempts: 0,
        evictedJobAliases: 0,
      }),
    };
    const batch: QueueDiagnosticsSourceBatch = source.read(0, 128);
    expect(batch.next).toBe(1);
    expect(Object.keys(source)).toEqual(['read']);
  });

  it('an attempt admits no payload, header, raw id, claim token or error', () => {
    // Compile-time: the exact member set IS the minimization contract.
    const event: QueueAttemptObservation = {
      sequence: 1,
      sourceId: 'q1',
      instanceAlias: 'mailer',
      queueAlias: 'emails',
      jobAlias: 'j1',
      attempt: 2,
      durationMs: 5,
      outcome: 'retryable-error',
      settlement: 'requeued',
      ageMs: 1,
    };
    expect(Object.keys(event).sort()).toEqual([
      'ageMs',
      'attempt',
      'durationMs',
      'instanceAlias',
      'jobAlias',
      'outcome',
      'queueAlias',
      'sequence',
      'settlement',
      'sourceId',
    ]);
  });

  it('the merged batch reports unsupported with the four loss counters', () => {
    const batch: QueueDiagnosticsBatch = {
      version: 1,
      instanceId: 'instance-1',
      state: 'unsupported',
      sources: [],
      events: [],
      depths: [],
      next: 0,
      lost: 0,
      truncatedSources: 0,
      truncatedDepths: 0,
    };
    expect(batch.state).toBe('unsupported');
  });
});

describe('M98g trace contracts', () => {
  const INSTANCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const TRACE = 'a'.repeat(32);
  const SPAN = 'b'.repeat(16);

  it('a consumer compiles against the trace source surface and the exact DTO', () => {
    const source: ITraceDiagnosticsSource = {
      read(instanceId: string, after: number, limit?: number): TraceDiagnosticsBatch {
        return {
          version: 1,
          instanceId,
          state: 'ready',
          coverage: 'completed-sampled-spans',
          instrumentation: ['http'],
          sampler: { kind: 'traceidratio', ratio: 0.5 },
          records: [
            {
              sequence: after + 1,
              serviceAlias: 'orders',
              operationAlias: 'create-order',
              traceId: TRACE,
              spanId: SPAN,
              ...(limit === undefined ? {} : { parentSpanId: SPAN }),
              links: [{ traceId: TRACE, spanId: SPAN }],
              kind: 'server',
              outcome: 'ok',
              durationMs: 5,
              ageMs: 1,
              parentVisibility: limit === undefined ? 'root' : 'observed',
            },
          ],
          next: after + 1,
          lost: 0,
          closed: false,
          droppedSpans: 0,
        };
      },
    };
    const batch = source.read(INSTANCE, 0, 128);
    expect(batch.version).toBe(1);
    expect(batch.instanceId).toBe(INSTANCE);
    expect(batch.state).toBe('ready');
    expect(batch.coverage).toBe('completed-sampled-spans');
    expect(batch.records[0]!.operationAlias).toBe('create-order');
    expect(batch.records[0]!.parentVisibility).toBe('observed');
    // The root-parent form: no parentSpanId, no fabricated edge.
    const root = source.read(INSTANCE, 0).records[0]!;
    expect(root.parentSpanId).toBeUndefined();
    expect(root.parentVisibility).toBe('root');
    expect(root.links).toEqual([{ traceId: TRACE, spanId: SPAN }]);
  });

  it('coverage vocabulary names every unavailability reason', () => {
    const coverage: TraceCoverage[] = [
      'completed-sampled-spans',
      'custom-provider',
      'noop-no-provider',
      'unknown',
    ];
    const states: TraceSourceState[] = [
      'disabled',
      'unsupported',
      'no-data',
      'ready',
      'collection-failed',
    ];
    expect(coverage).toHaveLength(4);
    expect(states).toHaveLength(5);
  });
});
