/**
 * Kernel diagnostics contracts — the read-only DTOs an application exposes
 * through {@linkcode IApplication.diagnostics} when kernel diagnostics are
 * explicitly enabled, and the pull-only reader interface a consumer calls.
 *
 * These are projection contracts, not live-object handles: every field is a
 * bounded primitive chosen by the kernel at its own registration and execution
 * boundaries. A snapshot never carries a handler, schema, service instance,
 * plugin option, configuration value, or environment map, and reading one can
 * never resolve a lazy factory or invoke application code.
 *
 * The reader is pull-only by design: `snapshot()` and `read()` return
 * immutable, frozen data and can neither register a callback nor mutate
 * application state. Network authentication and transport belong to a separate
 * connector milestone; this contract is the in-process boundary both consume.
 *
 * @module
 */

import type { HttpMethod } from '../types.ts';

/**
 * Kinds of node the kernel projects into a {@linkcode DiagnosticsSnapshot}.
 *
 * @since 0.8.0
 */
export type DiagnosticsNodeKind = 'plugin' | 'capability' | 'route' | 'middleware';

/**
 * Kinds of declared or observed relationship between two snapshot nodes.
 *
 * `provides`/`requires`/`optional`/`consumes` are DECLARED edges read from a
 * plugin's own declaration; `owns` is an OBSERVED edge recorded when a plugin's
 * `register()` performed a registration. A declared edge never claims an
 * observed call.
 *
 * @since 0.8.0
 */
export type DiagnosticsEdgeKind = 'provides' | 'requires' | 'optional' | 'consumes' | 'owns';

/**
 * Coarse application state reported by {@linkcode DiagnosticsSnapshot.state}.
 *
 * `failed` is terminal: a startup failure clears the retained topology and
 * event buffers and reports only this state, the failure code, and counters.
 *
 * @since 0.8.0
 */
export type DiagnosticsSnapshotState =
  | 'created'
  | 'starting'
  | 'running'
  | 'failed'
  | 'stopping'
  | 'closed';

/**
 * Bounded failure code reported by {@linkcode DiagnosticsSnapshot.failureCode}.
 *
 * Startup and shutdown failures are described through these two codes rather
 * than raw exception messages or stacks, so the snapshot cannot disclose error
 * text.
 *
 * @since 0.8.0
 */
export type DiagnosticsFailureCode = 'startup-failed' | 'shutdown-failed';

/**
 * Kinds of execution event in a {@linkcode DiagnosticsBatch}.
 *
 * `lifecycle` covers application startup and shutdown boundaries; `request` is
 * the per-request operation and its hooks; `middleware` and `handler` are the
 * measured stages inside one request operation.
 *
 * @since 0.8.0
 */
export type DiagnosticsEventKind = 'lifecycle' | 'request' | 'middleware' | 'handler';

/**
 * Outcome of an observed operation.
 *
 * `short-circuit` records a middleware stage that produced a response without
 * calling `next()`; `downstream-skipped` records a stage that called `next()`
 * after the response had already ended, so downstream work was skipped.
 * Skipped stages that never executed emit no record at all.
 *
 * @since 0.8.0
 */
export type DiagnosticsEventOutcome = 'ok' | 'error' | 'short-circuit' | 'downstream-skipped';

/**
 * The measured kernel boundary an event labels. A fixed vocabulary, not an
 * arbitrary application string: each value names one instrumented boundary,
 * and the timing of an event is the timing of that boundary only — never of
 * downstream work the boundary caused.
 *
 * @since 0.8.0
 */
export type DiagnosticsEventStage =
  | 'resolve'
  | 'register'
  | 'register-hook'
  | 'init'
  | 'bootstrap'
  | 'listen'
  | 'stopping'
  | 'shutdown'
  | 'close'
  | 'request'
  | 'request-hook'
  | 'response-hook'
  | 'error-hook'
  | 'global'
  | 'route'
  | 'handler'
  | 'websocket-upgrade'
  | 'grpc-dispatch';

/**
 * One node of the application-composition projection.
 *
 * Fields are emitted only when they are meaningful for {@linkcode kind}: a
 * plugin node carries `label`/`version`; a capability node carries
 * `label`/`registered`; a route node carries `label`/`method`; a middleware
 * node carries `label`/`priority`/`position`. There are no arbitrary
 * properties: unknown information is explicitly unavailable rather than
 * improvised.
 *
 * `id` is an opaque, per-instance sequential identifier (`p1`, `c1`, `r1`,
 * `m1`) containing no names, tenant identifiers, or user input. `label` is
 * present only when the application explicitly allowlisted that exact
 * registration string — an omission decision, never a truncation.
 *
 * A capability node's `registered` describes whether a registration was
 * observed; it never claims readiness, health, or lazy-instantiation state.
 *
 * @since 0.8.0
 */
export interface DiagnosticsNode {
  /** Opaque per-instance sequential identifier (`p1`, `c1`, `r1`, `m1`). */
  readonly id: string;
  /** What kind of composition member this node projects. */
  readonly kind: DiagnosticsNodeKind;
  /** Exactly the allowlisted registration string, when approved; absent otherwise. */
  readonly label?: string;
  /** Plugin semver, present only when it passed the bounded semver grammar. */
  readonly version?: string;
  /** Route HTTP method, projected onto the supported verb vocabulary. */
  readonly method?: HttpMethod;
  /** Global-middleware priority; execution positions use the stable priority sort. */
  readonly priority?: number;
  /** Execution position (1-based); distinct from registration order. */
  readonly position?: number;
  /** Capability nodes: whether a registration was observed. Never a readiness claim. */
  readonly registered?: boolean;
}

/**
 * One directed relationship between two snapshot nodes.
 *
 * @since 0.8.0
 */
export interface DiagnosticsEdge {
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
  /** Whether the relationship is declared by a plugin or observed at registration. */
  readonly kind: DiagnosticsEdgeKind;
}

/**
 * An immutable, bounded snapshot of application composition.
 *
 * The `nodes`/`edges` arrays are complete projections of collector-owned data
 * at read time; when topology or the serialized size exceeded the kernel's
 * fixed v1 limits, later entries are omitted and {@linkcode truncated} is set.
 * The exact UTF-8 byte length of the compact `JSON.stringify` of this object is
 * bounded by the kernel's snapshot budget, so a consumer can treat
 * `JSON.stringify(snapshot)` as a bounded response body.
 *
 * @since 0.8.0
 */
export interface DiagnosticsSnapshot {
  /** Contract version. */
  readonly version: 1;
  /** Process-instance UUID, assigned once the runtime is registered; `null` before that. */
  readonly instanceId: string | null;
  /** Coarse application state. */
  readonly state: DiagnosticsSnapshotState;
  /** Bounded failure code after a startup or shutdown failure; `null` otherwise. */
  readonly failureCode: DiagnosticsFailureCode | null;
  /** Composition nodes (plugins, capabilities, routes, middleware). */
  readonly nodes: readonly DiagnosticsNode[];
  /** Declared and observed relationships between nodes. */
  readonly edges: readonly DiagnosticsEdge[];
  /** `true` when topology or the snapshot budget caused entries to be omitted. */
  readonly truncated: boolean;
  /** Count of events dropped before entering the event buffer (saturated). */
  readonly droppedEvents: number;
}

/**
 * One execution observation.
 *
 * `sequence` is a dense per-instance counter shared by every event. Timing is
 * monotonic relative to runtime initialization: `atMs` is the inclusive start
 * offset and `durationMs` the inclusive elapsed time INCLUDING downstream
 * `next()` work — a consumer must not sum parent and child durations as
 * exclusive CPU time. Both are `null` for events recorded before the runtime
 * (and therefore the monotonic origin) existed; fabricated timings are never
 * emitted.
 *
 * `operationId` links the event to its operation and is allocated at entry, so
 * a child may reference a parent whose completion record appears later.
 * `parentOperationId` is `null` for an operation root (a lifecycle boundary or
 * the request operation itself).
 *
 * `statusCode`, `traceId`, and `spanId` are optional: a status is present only
 * on request/handler records that produced one, and trace identifiers are read
 * only from an already-resolved telemetry service and validated before being
 * carried — an absent, invalid, or throwing read is reported as absence.
 *
 * @since 0.8.0
 */
export interface DiagnosticsEvent {
  /** Dense per-instance sequence number; the cursor currency of {@linkcode IDiagnosticsSource.read}. */
  readonly sequence: number;
  /** Operation identifier allocated at entry (`op<N>`). */
  readonly operationId: string;
  /** Parent operation identifier, or `null` for an operation root. */
  readonly parentOperationId: string | null;
  /** What family of boundary produced the event. */
  readonly kind: DiagnosticsEventKind;
  /** The measured kernel boundary (fixed vocabulary). */
  readonly stage: DiagnosticsEventStage;
  /** Composition node the event is about, when one exists. */
  readonly nodeId: string | null;
  /** How the observed operation completed. */
  readonly outcome: DiagnosticsEventOutcome;
  /** Monotonic start offset in ms from runtime initialization; `null` before the runtime existed. */
  readonly atMs: number | null;
  /** Inclusive monotonic elapsed ms; `null` before the runtime existed. */
  readonly durationMs: number | null;
  /** Response status, when the boundary produced one. */
  readonly statusCode?: number;
  /** Validated 32-character lowercase-hex trace id, when an active span reported one. */
  readonly traceId?: string;
  /** Validated 16-character lowercase-hex span id, when an active span reported one. */
  readonly spanId?: string;
}

/**
 * One page of the event ring, read non-destructively.
 *
 * `events` are frozen records in completion order. `next` is the last returned
 * sequence, or the requested cursor when nothing was returned; pass it as the
 * next `after` to continue polling. `lost` is the count of sequence numbers
 * that were evicted between the requested cursor and the first returned record
 * — the cost of a bounded ring under load, reported rather than hidden.
 *
 * @since 0.8.0
 */
export interface DiagnosticsBatch {
  /** Contract version. */
  readonly version: 1;
  /** Process-instance UUID, or `null` before the runtime was registered. */
  readonly instanceId: string | null;
  /** Frozen events with sequence numbers greater than the requested cursor. */
  readonly events: readonly DiagnosticsEvent[];
  /** Last returned sequence, or the requested cursor when nothing was returned. */
  readonly next: number;
  /** Evicted sequence numbers between the requested cursor and the first returned record. */
  readonly lost: number;
  /** `true` once the application has stopped and the ring will not receive further events. */
  readonly closed: boolean;
}

/**
 * Read-only diagnostics reader — the surface exposed through the optional
 * {@linkcode IApplication.diagnostics} member when the application was created
 * with diagnostics explicitly enabled.
 *
 * Pull-only by contract: neither method registers a callback, invokes
 * application code, resolves a service, or mutates state. Readers are
 * independent and non-destructive — one slow or stopped reader never steals
 * events from another. Returned data is deeply frozen; holding it cannot
 * observe later application activity.
 *
 * @example
 * ```typescript
 * const app = createApplication({ plugins, diagnostics: {} });
 * await app.start();
 * await app.inject({ method: 'GET', url: '/health' });
 * const snap = app.diagnostics!.snapshot();
 * const batch = app.diagnostics!.read(0, 128);
 * ```
 * @since 0.8.0
 */
export interface IDiagnosticsSource {
  /**
   * Returns the current composition snapshot. Repeated calls between
   * mutations return the same frozen, cached object; a mutation rebuilds it.
   *
   * @returns A deeply frozen {@linkcode DiagnosticsSnapshot}
   */
  snapshot(): DiagnosticsSnapshot;
  /**
   * Returns the next batch of execution events after `after`, oldest first.
   *
   * @param after - Sequence cursor; `0` starts at the oldest retained record
   * @param limit - Maximum events to return, 1–128 (default 128)
   * @returns A frozen {@linkcode DiagnosticsBatch}
   * @throws {RangeError} When `after` is not a non-negative safe integer, when
   * `limit` is not an integer from 1 to 128, or when `after` is beyond the
   * current sequence — with a fixed message that never echoes the value
   */
  read(after: number, limit?: number): DiagnosticsBatch;
}

/**
 * Coarse availability state of one inspector served by the diagnostics
 * connector.
 *
 * `unsupported` is a connector-side answer: the connector implements the
 * operation, but the owning application did not register the inspector's
 * source. `disabled` is the owning plugin's answer: the source is registered
 * but observation was not opted in. The two are distinct so a consumer can
 * tell "not present" from "present but off".
 *
 * @since 0.8.0
 */
export type DiagnosticsInspectorState =
  | 'unsupported'
  | 'disabled'
  | 'no-data'
  | 'ready'
  | 'stale'
  | 'collection-failed';

/**
 * Outcome of one observed health check, as projected by the health
 * diagnostics inspector.
 *
 * `reported` means the check settled within its deadline and the framework's
 * own status is carried. `timed-out` and `failed` are the framework's fixed
 * failure categories (deadline hit, indicator rejected) — the thrown value
 * and the indicator's `data` are never projected. `never-observed` is an
 * approved alias for which no check has settled yet.
 *
 * @since 0.8.0
 */
export type HealthObservationState = 'reported' | 'timed-out' | 'failed' | 'never-observed';

/**
 * One minimized health observation: the latest outcome for one approved
 * indicator alias.
 *
 * `indicatorAlias` is the display alias the application explicitly
 * allowlisted for the indicator's registered name — never the name itself.
 * `status` is present only when {@linkcode state} is `reported`. `latencyMs`
 * and `ageMs` are monotonic measurements on the runtime clock: `latencyMs`
 * is how long the check took, `ageMs` the elapsed time since the observation
 * was captured, and both are `null` exactly when the alias was never
 * observed. No absolute time, no error text, and no indicator `data` is
 * admitted; a status outside `up`/`degraded`/`down` is never carried — such
 * a check is projected as `failed`.
 *
 * @since 0.8.0
 */
export interface HealthDiagnosticsObservation {
  /** The approved display alias for the indicator. */
  readonly indicatorAlias: string;
  /** The framework's own health status, present only when reported. */
  readonly status?: 'up' | 'degraded' | 'down';
  /** How the observed check completed. */
  readonly state: HealthObservationState;
  /** Monotonic elapsed ms of the check; `null` when never observed. */
  readonly latencyMs: number | null;
  /** Monotonic ms since capture; `null` when never observed. */
  readonly ageMs: number | null;
  /** Whether the observation came from a normal check or a scheduled one. */
  readonly origin: 'application' | 'scheduled';
}

/**
 * An immutable, minimized snapshot of health observations.
 *
 * The snapshot contains only {@linkcode version}, {@linkcode instanceId},
 * {@linkcode state}, {@linkcode observations}, {@linkcode truncated}, and
 * {@linkcode droppedObservations}. `observations` is a complete projection of
 * the collector's retained latest-per-alias records at read time; when the
 * serialized size would exceed the fixed 256 KiB snapshot budget, later
 * entries are omitted and {@linkcode truncated} is set. The exact UTF-8 byte length of
 * the compact `JSON.stringify` of this object is bounded by the connector's
 * response budget.
 *
 * @since 0.8.0
 */
export interface HealthDiagnosticsSnapshot {
  /** Contract version. */
  readonly version: 1;
  /** The instance UUID the snapshot was read for; must equal the caller's. */
  readonly instanceId: string;
  /** Coarse inspector availability state. */
  readonly state: DiagnosticsInspectorState;
  /** Latest-per-alias observations, in stable alias order. */
  readonly observations: readonly HealthDiagnosticsObservation[];
  /** `true` when the bound caused entries to be omitted. */
  readonly truncated: boolean;
  /** Count of observations dropped before entering the retained set. */
  readonly droppedObservations: number;
}

/**
 * Read-only health diagnostics source — the surface the HealthPlugin
 * registers under {@linkcode CAPABILITIES.HEALTH_DIAGNOSTICS} and the
 * DiagnosticsPlugin consumes to serve `GET /v1/health`.
 *
 * Synchronous by contract: `snapshot(instanceId)` returns an already-built
 * frozen DTO and never invokes an application indicator, resolves a lazy
 * factory, or mutates state. The connector validates the returned DTO and
 * applies the wire bounds; a source that throws is reported as a
 * value-free `collection-failed` snapshot, never as a fault that changes the
 * application's readiness.
 *
 * @example
 * ```typescript
 * const source = ctx.services.get<IHealthDiagnosticsSource>(
 *   CAPABILITIES.HEALTH_DIAGNOSTICS,
 * );
 * const snapshot = source.snapshot(instanceId);
 * ```
 * @since 0.8.0
 */
export interface IHealthDiagnosticsSource {
  /**
   * Returns the current minimized health snapshot for the given instance.
   *
   * @param instanceId - The non-empty instance UUID to bind the snapshot to
   * @returns A deeply frozen {@linkcode HealthDiagnosticsSnapshot} whose
   * `instanceId` exactly equals the argument
   * @throws {RangeError} When `instanceId` is not a non-empty string — with a
   * fixed message that never echoes the value
   */
  snapshot(instanceId: string): HealthDiagnosticsSnapshot;
}

/**
 * Where a configuration key's final value was observed to come from.
 *
 * `environment` and `file` are the two sources the loader itself reads; each
 * value names its producer. `unknown` has exactly two producers: an opaque
 * injected `IConfig` instance, whose internals no observation can reach, and
 * a key present in the post-schema snapshot for which no environment or file
 * source was observed — it appeared only after schema parsing. `unknown`
 * never claims a mechanism, only the absence of an observed source.
 *
 * @since 0.8.0
 */
export type ConfigProvenanceOrigin = 'environment' | 'file' | 'unknown';

/**
 * The schema effect observed for one approved key, derived only from
 * input/output property PRESENCE around the schema parse.
 *
 * `validated` means the key was present in the loaded input and in the
 * parsed output. `introduced` means it was absent from the input and present
 * in the output — a schema default and a transform deriving the key from
 * other inputs produce the identical presence pattern, so `introduced`
 * reports the appearance and NOT its cause. `removed` means present in the
 * input and absent from the output. `not-configured` means no validation
 * schema was configured. `unknown` means no observation can establish any
 * effect — the opaque injected instance. Naming a mechanism the observation
 * cannot establish (for example `defaulted`) would misstate the source for
 * every transform-derived key, so the vocabulary stays at what presence can
 * prove.
 *
 * @since 0.8.0
 */
export type ConfigSchemaEffect =
  | 'not-configured'
  | 'validated'
  | 'introduced'
  | 'removed'
  | 'unknown';

/**
 * One minimized provenance record for one approved configuration key alias.
 *
 * Every string is an application-approved display alias — never a raw key
 * name, never a file path, and never a value. `origin` names the producer of
 * the final value; `sourceAlias` is present only when the origin is `file`
 * AND the configured file path was explicitly approved. `expanded` reports
 * that the key's already-loaded raw string contained the `${NAME}` expansion
 * grammar; `referenceAliases` carries the approved aliases of the keys it
 * referenced (references with unapproved endpoints are omitted, never
 * named). `overriddenSourceAliases` carries the approved aliases of the
 * sources this key's value displaced, in displacement order. No field ever
 * carries a value, a value hash, a value length, or an absolute path.
 *
 * @since 0.8.0
 */
export interface ConfigProvenanceEntry {
  /** The approved display alias for the configuration key. */
  readonly keyAlias: string;
  /** Where the final value was observed to come from. */
  readonly origin: ConfigProvenanceOrigin;
  /** The approved source alias for a `file` origin; absent otherwise. */
  readonly sourceAlias?: string;
  /** Approved aliases of the sources this value displaced, in displacement order. */
  readonly overriddenSourceAliases: readonly string[];
  /** Whether the key's loaded raw string contained the `${NAME}` grammar. */
  readonly expanded: boolean;
  /** Approved aliases of the keys this key's expansion referenced. */
  readonly referenceAliases: readonly string[];
  /** The schema effect observed for this key. */
  readonly schemaEffect: ConfigSchemaEffect;
}

/**
 * An immutable, minimized snapshot of configuration provenance.
 *
 * The snapshot contains only {@linkcode version}, {@linkcode instanceId},
 * {@linkcode state}, {@linkcode entries}, {@linkcode truncated}, and
 * {@linkcode droppedEntries}. `entries` is the projection of the approved
 * keys in stable declaration order; when the serialized size would exceed
 * the fixed 256 KiB snapshot budget, later entries are omitted and
 * {@linkcode truncated} is set. `droppedEntries` counts entries omitted by
 * that budget — unapproved keys are never observed at all, so no counter
 * discloses how many exist. The exact UTF-8 byte length of the compact
 * `JSON.stringify` of this object is bounded by the connector's response
 * budget.
 *
 * @since 0.8.0
 */
export interface ConfigDiagnosticsSnapshot {
  /** Contract version. */
  readonly version: 1;
  /** The instance UUID the snapshot was read for; must equal the caller's. */
  readonly instanceId: string;
  /** Coarse inspector availability state. */
  readonly state: DiagnosticsInspectorState;
  /** Latest provenance for the approved keys, in stable declaration order. */
  readonly entries: readonly ConfigProvenanceEntry[];
  /** `true` when the size budget caused entries to be omitted. */
  readonly truncated: boolean;
  /** Count of entries omitted by the size budget. */
  readonly droppedEntries: number;
}

/**
 * Read-only configuration provenance source — the surface the ConfigPlugin
 * registers under {@linkcode CAPABILITIES.CONFIG_DIAGNOSTICS} and the
 * DiagnosticsPlugin consumes to serve `GET /v1/config`.
 *
 * Synchronous by contract: `snapshot(instanceId)` returns an already-built
 * frozen DTO and performs no environment, filesystem, schema, or lazy-service
 * operation, adds no read to the underlying `IConfig`, and never enumerates
 * it. A source that throws is reported by the connector as a value-free
 * `collection-failed` snapshot, never as a fault that changes application
 * behavior.
 *
 * @example
 * ```typescript
 * const source = ctx.services.get<IConfigDiagnosticsSource>(
 *   CAPABILITIES.CONFIG_DIAGNOSTICS,
 * );
 * const snapshot = source.snapshot(instanceId);
 * ```
 * @since 0.8.0
 */
export interface IConfigDiagnosticsSource {
  /**
   * Returns the current minimized provenance snapshot for the given instance.
   *
   * @param instanceId - The non-empty instance UUID to bind the snapshot to
   * @returns A deeply frozen {@linkcode ConfigDiagnosticsSnapshot} whose
   * `instanceId` exactly equals the argument
   * @throws {RangeError} When `instanceId` is not a non-empty string — with a
   * fixed message that never echoes the value
   */
  snapshot(instanceId: string): ConfigDiagnosticsSnapshot;
}

/**
 * How the dispatched work for one queue attempt completed (M98f).
 *
 * `completed` means the dispatched chain — every configured ingress behaviour
 * and the processor — returned normally, including a behaviour that
 * short-circuited without calling `next()`. `retryable-error` means it threw
 * while attempts remained, and `terminal-error` means it threw on the final
 * attempt. The thrown value itself is never projected.
 *
 * An outcome is NOT proof that the job was durably settled: see
 * {@linkcode QueueSettlementState}.
 *
 * @since 0.8.0
 */
export type QueueProcessorOutcome = 'completed' | 'retryable-error' | 'terminal-error';

/**
 * What the queue framework observed about settling one attempt (M98f),
 * reported only AFTER the adapter's settlement call returned.
 *
 * `acknowledged`, `requeued` and `dead-lettered` mean the matching settlement
 * call completed against an adapter that confirms its settlement calls.
 * `failed` means the settlement call rejected. `unknown` means the call
 * completed but the adapter cannot confirm the backend applied it — RabbitMQ's
 * channel operations are unconfirmed, and SQS absorbs a lapsed claim or a
 * failed dead-letter send without rejecting — so a completed call there is
 * never presented as settlement proof.
 *
 * @since 0.8.0
 */
export type QueueSettlementState =
  | 'acknowledged'
  | 'requeued'
  | 'dead-lettered'
  | 'failed'
  | 'unknown';

/**
 * What a queue depth observation counts (M98f).
 *
 * `process-local` counts only this process's in-memory queue; `shared-backend`
 * counts a backend other replicas share. Shared-backend depths from several
 * sources or replicas describe the SAME inventory and must never be summed.
 *
 * @since 0.8.0
 */
export type QueueDepthScope = 'process-local' | 'shared-backend';

/**
 * Whether the depth cycle that produced an observation read every approved
 * queue of its source (M98f). `partial` means at least one approved queue of
 * that cycle was left unread — failed, timed out, or skipped because its
 * previous read had not settled — so the observation must not be combined with
 * its siblings as a whole-source total.
 *
 * @since 0.8.0
 */
export type QueueDepthCycleCoverage = 'complete' | 'partial';

/**
 * A queue source's depth-collection coverage (M98f).
 *
 * `disabled` — the application configured no depth collection. `unavailable`
 * — the adapter cannot count (RabbitMQ, SQS, or an injected client without the
 * required primitive); it is never reported as zero. `pending` — collection is
 * configured but no cycle has completed. `complete` / `partial` — the latest
 * completed cycle read every approved queue, or left at least one unread.
 *
 * @since 0.8.0
 */
export type QueueDepthCoverage = 'disabled' | 'unavailable' | 'pending' | 'complete' | 'partial';

/**
 * The fixed failure category a queue source reports about its latest depth
 * cycle (M98f): `none`, `depth-read-failed` (at least one count call rejected
 * or answered an invalid shape), or `depth-read-timed-out` (at least one did
 * not settle within its reporting deadline). A failure is never described by
 * error text.
 *
 * @since 0.8.0
 */
export type QueueSourceFailure = 'none' | 'depth-read-failed' | 'depth-read-timed-out';

/**
 * The fixed failure category a {@linkcode QueueDiagnosticsSourceStatus}
 * carries: a source's own {@linkcode QueueSourceFailure}, or the connector's
 * `source-read-failed` when reading the source threw or answered a shape the
 * connector could not validate.
 *
 * @since 0.8.0
 */
export type QueueDiagnosticsFailure = QueueSourceFailure | 'source-read-failed';

/**
 * A queue source's own inspector state (M98f): `disabled` when the queue plugin
 * was not configured for observation, `no-data` when it is configured but has
 * neither observed an attempt nor completed a depth read, `ready` otherwise.
 *
 * @since 0.8.0
 */
export type QueueSourceState = 'disabled' | 'no-data' | 'ready';

/**
 * One observed queue attempt as a queue source retains it (M98f).
 *
 * `sequence` is the source-local, dense cursor currency of
 * {@linkcode IQueueDiagnosticsSource.read}. `queueAlias` is the display alias
 * the application approved for the job name — never the name itself — and
 * `jobAlias` a session-local `j<N>` alias for the raw job identifier, which
 * never leaves the collector. `durationMs` is the monotonic elapsed time from
 * dispatch until the settlement call returned; `ageMs` the monotonic elapsed
 * time since then. No payload, header, claim token, attempt limit or thrown
 * value is admitted.
 *
 * @since 0.8.0
 */
export interface QueueSourceAttemptObservation {
  /** Dense, source-local sequence number. */
  readonly sequence: number;
  /** The approved display alias for the job name. */
  readonly queueAlias: string;
  /** Session-local `j<N>` alias for the raw job identifier. */
  readonly jobAlias: string;
  /** The 1-based attempt number of this delivery. */
  readonly attempt: number;
  /** Monotonic ms from dispatch until the settlement call returned. */
  readonly durationMs: number;
  /** How the dispatched work completed. */
  readonly outcome: QueueProcessorOutcome;
  /** What was observed about settling the attempt. */
  readonly settlement: QueueSettlementState;
  /** Monotonic ms since the attempt settled. */
  readonly ageMs: number;
}

/**
 * The latest depth of one approved queue, as a queue source retains it
 * (M98f). Counts are non-negative integers read by an explicitly scheduled
 * count cycle — never by a diagnostic read.
 *
 * @since 0.8.0
 */
export interface QueueSourceDepthObservation {
  /** The approved display alias for the job name. */
  readonly queueAlias: string;
  /** Jobs available to be reserved now or later. */
  readonly ready: number;
  /** Jobs reserved and being processed. */
  readonly processing: number;
  /** Jobs that exhausted their attempts and were dead-lettered. */
  readonly dead: number;
  /** What the counts cover. */
  readonly scope: QueueDepthScope;
  /** Whether the producing cycle read every approved queue of the source. */
  readonly coverage: QueueDepthCycleCoverage;
  /** Monotonic ms since the counts were captured. */
  readonly ageMs: number;
}

/**
 * One page of a single queue source (M98f), read non-destructively.
 *
 * `after`/`next`/`lost` follow the M98a cursor contract of
 * {@linkcode DiagnosticsBatch} exactly: `after` is exclusive, a cursor older
 * than the oldest retained attempt returns the oldest retained attempts with
 * the skipped sequences reported in `lost`, and `next` is the last returned
 * sequence — or the requested cursor when nothing was returned. `depths` is a
 * latest-only view, not a history. `droppedAttempts` counts attempts
 * dropped from observation — the in-flight bound was reached, the persisted
 * attempt number was malformed, or the runner failed before reporting a
 * settlement — and `evictedJobAliases` the
 * job aliases evicted from the bounded alias map (a later retry of an evicted
 * job receives a new alias); both saturate.
 *
 * @since 0.8.0
 */
export interface QueueDiagnosticsSourceBatch {
  /** Contract version. */
  readonly version: 1;
  /** The source's own inspector state. */
  readonly state: QueueSourceState;
  /** The configured display alias for this queue plugin instance; absent when disabled. */
  readonly instanceAlias?: string;
  /** Depth-collection coverage. */
  readonly depthCoverage: QueueDepthCoverage;
  /** Fixed failure category of the latest depth cycle. */
  readonly failure: QueueSourceFailure;
  /** Frozen attempts with sequence numbers greater than the requested cursor. */
  readonly attempts: readonly QueueSourceAttemptObservation[];
  /** Latest-only depth observations, in approved-queue order. */
  readonly depths: readonly QueueSourceDepthObservation[];
  /** Last returned sequence, or the requested cursor when nothing was returned. */
  readonly next: number;
  /** Evicted sequence numbers between the requested cursor and the first returned attempt. */
  readonly lost: number;
  /** `true` once the queue plugin has closed and the source retains nothing. */
  readonly closed: boolean;
  /**
   * Attempts dropped from observation (saturating): the in-flight bound was
   * reached, the persisted attempt number was not a positive safe integer, or
   * the runner failed before reporting a settlement.
   */
  readonly droppedAttempts: number;
  /** Job aliases evicted from the bounded alias map (saturating). */
  readonly evictedJobAliases: number;
}

/**
 * Read-only queue diagnostics source — the surface every QueuePlugin
 * instance registers under {@linkcode CAPABILITIES.QUEUE_DIAGNOSTICS} as a
 * MULTI provider, so named queue instances stay independently observable.
 * The DiagnosticsPlugin consumes every registered source to serve
 * `GET /v1/queues`.
 *
 * Synchronous by contract: `read` returns already-captured, frozen data and
 * never reserves, acknowledges, retries, dead-letters, enumerates or counts a
 * job. A source whose queue plugin was not configured for observation answers
 * `disabled`.
 *
 * @example
 * ```typescript
 * const sources = ctx.services.getAll<IQueueDiagnosticsSource>(
 *   CAPABILITIES.QUEUE_DIAGNOSTICS,
 * );
 * const batch = sources[0].read(0, 128);
 * ```
 * @since 0.8.0
 */
export interface IQueueDiagnosticsSource {
  /**
   * Returns the source's attempts after `after`, oldest first, plus its
   * latest depth observations.
   *
   * @param after - Source-local sequence cursor; `0` starts at the oldest retained attempt
   * @param limit - Maximum attempts to return, 1–128 (default 128)
   * @returns A deeply frozen {@linkcode QueueDiagnosticsSourceBatch}
   * @throws {RangeError} When `after` is not a non-negative safe integer, when
   * `limit` is not an integer from 1 to 128, or when `after` is beyond the
   * source's current sequence — with a fixed message that never echoes the
   * value
   */
  read(after: number, limit?: number): QueueDiagnosticsSourceBatch;
}

/**
 * The status of one queue source as the diagnostics connector reports it
 * (M98f).
 *
 * `sourceId` is a connector-assigned opaque `q<N>` identifier in registration
 * order — never a plugin name or capability token. `state` is the source's own
 * state, or `collection-failed` when the connector could not read it. `lost`
 * accumulates (saturating) the attempts that source's OWN bounded ring evicted
 * before the connector drained them — a busy queue outrunning the poller —
 * which the batch-level `lost` of {@linkcode QueueDiagnosticsBatch} never
 * includes.
 *
 * @since 0.8.0
 */
export interface QueueDiagnosticsSourceStatus {
  /** Connector-assigned opaque `q<N>` source identifier. */
  readonly sourceId: string;
  /** The source's state, or `collection-failed` when it could not be read. */
  readonly state: QueueSourceState | 'collection-failed';
  /** The configured display alias for the queue plugin instance, when enabled. */
  readonly instanceAlias?: string;
  /** Depth-collection coverage. */
  readonly depthCoverage: QueueDepthCoverage;
  /** Fixed failure category. */
  readonly failure: QueueDiagnosticsFailure;
  /** Attempts this source's own ring evicted before they were drained (saturating). */
  readonly lost: number;
  /**
   * Attempts dropped from observation (saturating): the in-flight bound was
   * reached, the persisted attempt number was not a positive safe integer, or
   * the runner failed before reporting a settlement.
   */
  readonly droppedAttempts: number;
  /** Job aliases evicted from the bounded alias map (saturating). */
  readonly evictedJobAliases: number;
}

/**
 * One observed queue attempt as the diagnostics connector serves it (M98f).
 * `sequence` is the connector's merge sequence — the cursor currency of the
 * queue read — assigned in source registration order as sources are drained,
 * so it orders drains rather than wall-clock completion across sources.
 *
 * @since 0.8.0
 */
export interface QueueAttemptObservation {
  /** Dense connector merge sequence number. */
  readonly sequence: number;
  /** The `q<N>` identifier of the source that observed the attempt. */
  readonly sourceId: string;
  /** The configured display alias for the queue plugin instance. */
  readonly instanceAlias: string;
  /** The approved display alias for the job name. */
  readonly queueAlias: string;
  /** Session-local `j<N>` job alias, unique within its source. */
  readonly jobAlias: string;
  /** The 1-based attempt number of this delivery. */
  readonly attempt: number;
  /** Monotonic ms from dispatch until the settlement call returned. */
  readonly durationMs: number;
  /** How the dispatched work completed. */
  readonly outcome: QueueProcessorOutcome;
  /** What was observed about settling the attempt. */
  readonly settlement: QueueSettlementState;
  /** Monotonic ms since the attempt settled. */
  readonly ageMs: number;
}

/**
 * The latest depth of one approved queue as the diagnostics connector serves
 * it (M98f).
 *
 * @since 0.8.0
 */
export interface QueueDepthObservation {
  /** The `q<N>` identifier of the source that counted the queue. */
  readonly sourceId: string;
  /** The configured display alias for the queue plugin instance. */
  readonly instanceAlias: string;
  /** The approved display alias for the job name. */
  readonly queueAlias: string;
  /** Jobs available to be reserved now or later. */
  readonly ready: number;
  /** Jobs reserved and being processed. */
  readonly processing: number;
  /** Jobs that exhausted their attempts and were dead-lettered. */
  readonly dead: number;
  /** What the counts cover; `shared-backend` counts are never summed across sources. */
  readonly scope: QueueDepthScope;
  /** Whether the producing cycle read every approved queue of the source. */
  readonly coverage: QueueDepthCycleCoverage;
  /** Monotonic ms since the counts were captured. */
  readonly ageMs: number;
}

/**
 * One page of queue observations across every registered queue source
 * (M98f), as the diagnostics connector serves `GET /v1/queues`.
 *
 * `state` is `unsupported` when no queue source is registered (or the client
 * negotiated no queue inspector), otherwise `ready` — per-source states are in
 * `sources`. `after`/`next`/`lost` follow the M98a cursor contract over the
 * connector's merge ring; `lost` counts only MERGE-ring eviction, while each
 * source's own eviction is reported in its status. `truncatedSources` counts
 * registered sources beyond the fixed 16-source bound that are never read, and
 * `truncatedDepths` the depth observations omitted to keep the frame within its
 * fixed 256 KiB budget. With those four counters a consumer can always say what
 * it did not see.
 *
 * @since 0.8.0
 */
export interface QueueDiagnosticsBatch {
  /** Contract version. */
  readonly version: 1;
  /** The instance UUID the batch was read for. */
  readonly instanceId: string;
  /** `unsupported` when no queue source is registered; `ready` otherwise. */
  readonly state: 'unsupported' | 'ready';
  /** One status per retained source, in registration order. */
  readonly sources: readonly QueueDiagnosticsSourceStatus[];
  /** Attempts with merge sequence numbers greater than the requested cursor. */
  readonly events: readonly QueueAttemptObservation[];
  /** Latest-only depth observations across the retained sources. */
  readonly depths: readonly QueueDepthObservation[];
  /** Last returned merge sequence, or the requested cursor when nothing was returned. */
  readonly next: number;
  /** Merge-ring sequences evicted between the requested cursor and the first returned event. */
  readonly lost: number;
  /** Registered sources beyond the 16-source bound, never read. */
  readonly truncatedSources: number;
  /** Depth observations omitted to fit the frame budget. */
  readonly truncatedDepths: number;
}
