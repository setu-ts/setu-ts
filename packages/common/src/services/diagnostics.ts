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
