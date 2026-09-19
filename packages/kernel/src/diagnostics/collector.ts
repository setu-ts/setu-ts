/**
 * Diagnostics collector — the kernel-owned writer and the public pull-only
 * reader behind `IApplication.diagnostics`.
 *
 * Ownership is the whole design: only the kernel implementation writes here,
 * at its own registration and execution boundaries, projecting bounded
 * primitives captured once at the owning mutation. The reader offers exactly
 * `snapshot()` and `read()` — neither can register a callback, invoke
 * application code, resolve a service, or mutate state — so an external
 * reader can be slow, stop polling, or throw after reading without any effect
 * on the application.
 *
 * Every mutation and execution call site passes through {@linkcode
 * DiagnosticsCollector.safeObserve}: an inspection failure must never change a
 * response, a lifecycle result, or a startup error. An event-capture failure
 * drops the record, increments a value-free counter, and disables further
 * event capture; a topology-capture failure drops that entry and marks the
 * snapshot truncated.
 *
 * @module
 */
import type {
  DiagnosticsBatch,
  DiagnosticsEdge,
  DiagnosticsEdgeKind,
  DiagnosticsEvent,
  DiagnosticsEventKind,
  DiagnosticsEventOutcome,
  DiagnosticsEventStage,
  DiagnosticsFailureCode,
  DiagnosticsNode,
  DiagnosticsNodeKind,
  DiagnosticsSnapshot,
  DiagnosticsSnapshotState,
  HttpMethod,
  IDiagnosticsSource,
} from '@setu-ts/common';

import type { RouteRegistrationEvent } from '../router/router.ts';
import type { RegistryDiagnosticEvent } from '../registry/service-registry.ts';

import {
  DiagnosticsEventRing,
  eventWithinByteCap,
  MAX_EVENT_FIELD_LENGTH,
  validateReadCursor,
} from './buffer.ts';
import {
  applySnapshotBudget,
  approvedLabel,
  boundedPluginVersion,
  MAX_EDGES,
  MAX_NODES,
  projectHttpMethod,
  saturatingNext,
} from './projection.ts';
import type { DiagnosticsLabelAllowlists } from './projection.ts';

/** Capture-time description of one plugin, taken at its registration boundary. */
export interface PluginRegistrationInfo {
  /** The plugin's declared `name`. */
  readonly name: string;
  /** The plugin's declared `version`, emitted only when it passes the bounded grammar. */
  readonly version: string;
  /** Declared `provides` tokens. */
  readonly provides: readonly string[];
  /** Declared `requires` tokens. */
  readonly requires: readonly string[];
  /** Declared `optionalDependencies` tokens. */
  readonly optionalDependencies: readonly string[];
  /** Declared `consumes` tokens. */
  readonly consumes: readonly string[];
}

/** Capture-time description of one global middleware stage, in execution order. */
export interface MiddlewareCompiledDescriptor {
  readonly name: string;
  readonly priority: number;
  /** 1-based execution position in the stable priority sort. */
  readonly position: number;
}

/** An operation allocated at entry, linking later records to their parent. */
export interface DiagnosticsOperation {
  readonly id: string;
  readonly startedAtMs: number | null;
}

/** Parts of one completion record the collector turns into a stored event. */
export interface CompletionRecordParts {
  readonly kind: DiagnosticsEventKind;
  readonly stage: DiagnosticsEventStage;
  readonly operationId: string;
  readonly parentOperationId: string | null;
  readonly nodeId: string | null;
  readonly outcome: DiagnosticsEventOutcome;
  readonly startedAtMs: number | null;
  readonly durationMs: number | null;
  readonly statusCode?: number;
  /** Whether the record may carry validated trace/span identifiers. */
  readonly withTrace?: boolean;
}

/** The validated telemetry identifiers a record may carry. */
interface TraceIdentifiers {
  readonly traceId?: string;
  readonly spanId?: string;
}

/** The slice of `ITelemetryService` the collector reads, kept structural. */
interface TraceReadingTelemetry {
  activeSpanContext?(): { readonly traceId: string; readonly spanId: string } | undefined;
}

interface NodeRecord {
  readonly id: string;
  readonly kind: DiagnosticsNodeKind;
  readonly label?: string;
  readonly version?: string;
  readonly method?: HttpMethod;
  readonly priority?: number;
  readonly position?: number;
  registered?: boolean;
}

interface EdgeRecord {
  readonly from: string;
  readonly to: string;
  readonly kind: DiagnosticsEdgeKind;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const NON_ZERO = /[1-9a-f]/;

/**
 * Recursively freezes a DTO so a reader holding it can observe nothing that
 * happens afterwards.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The collector. Instantiated ONLY when the application was created with
 * `diagnostics` explicitly enabled; an omitted option never constructs one.
 * @since 0.8.0
 */
export class DiagnosticsCollector implements IDiagnosticsSource {
  readonly #labels: DiagnosticsLabelAllowlists;
  readonly #ring = new DiagnosticsEventRing();
  readonly #nodes: NodeRecord[] = [];
  readonly #edges: EdgeRecord[] = [];
  readonly #edgeKeys = new Set<string>();
  readonly #pluginNodesByName = new Map<string, NodeRecord>();
  readonly #capabilityNodesByToken = new Map<string, NodeRecord>();
  readonly #routeNodeIds = new Map<number, NodeRecord>();
  readonly #routeMiddlewareNodes = new Map<number, NodeRecord[]>();
  readonly #globalMiddlewareNodes: NodeRecord[] = [];
  readonly #requestOperations = new WeakMap<object, DiagnosticsOperation>();
  #cachedSnapshot: DiagnosticsSnapshot | undefined;
  #snapshotDirty = true;
  #state: DiagnosticsSnapshotState = 'created';
  #failureCode: DiagnosticsFailureCode | null = null;
  #topologyTruncated = false;
  #droppedEvents = 0;
  #eventCaptureDisabled = false;
  #opCounter = 0;
  #pluginCounter = 0;
  #capabilityCounter = 0;
  #routeCounter = 0;
  #middlewareCounter = 0;
  #instanceId: string | null = null;
  #runtimeInitialized = false;
  #clock: (() => number | null) | undefined;
  #telemetryReader: (() => TraceReadingTelemetry | undefined) | undefined;

  constructor(labels: DiagnosticsLabelAllowlists) {
    this.#labels = labels;
  }

  // ---------------------------------------------------------------------------
  // Reader — the whole public surface (IDiagnosticsSource)
  // ---------------------------------------------------------------------------

  /** @inheritDoc */
  snapshot(): DiagnosticsSnapshot {
    if (this.#cachedSnapshot !== undefined && !this.#snapshotDirty) {
      return this.#cachedSnapshot;
    }
    // The budget applies to the FINAL DTO: entries are omitted (with their
    // edges) until the exact compact UTF-8 length fits — the trim is the pure
    // `applySnapshotBudget` seam in projection.ts. M98b re-measures the same
    // bytes before signing, so no accepted snapshot can exceed the cap.
    const frozen = deepFreeze(
      applySnapshotBudget(
        {
          instanceId: this.#instanceId,
          state: this.#state,
          failureCode: this.#failureCode,
          droppedEvents: this.#droppedEvents,
        },
        this.#nodes.map(nodeToDto),
        this.#edges.map(edgeToDto),
        this.#topologyTruncated,
      ),
    );
    this.#cachedSnapshot = frozen;
    this.#snapshotDirty = false;
    return frozen;
  }

  /** @inheritDoc */
  read(after: number, limit?: number): DiagnosticsBatch {
    // A closed ring has no "beyond the sequence" refusal: a reader that polled
    // up to sequence N before shutdown must still get its empty closed batch,
    // not a throw, after teardown reset the counters.
    const cursor = validateReadCursor(
      after,
      limit,
      this.#ring.closed ? Number.MAX_SAFE_INTEGER : this.#ring.lastSequence,
    );
    if (this.#ring.closed) {
      return deepFreeze({
        version: 1 as const,
        instanceId: this.#instanceId,
        events: Object.freeze([]),
        next: after,
        lost: 0,
        closed: true,
      });
    }
    // The window starts at the first RETAINED sequence past the cursor — a
    // cursor parked behind an eviction receives the oldest retained records,
    // with the skipped sequences reported as `lost`, never an empty page.
    const start = Math.max(after + 1, this.#ring.firstSequence);
    const end = Math.min(this.#ring.lastSequence, start + cursor.limit - 1);
    const events: DiagnosticsEvent[] = [];
    for (let sequence = start; sequence <= end; sequence++) {
      events.push(this.#ring.at(sequence)!);
    }
    const lost = events.length > 0 ? start - after - 1 : 0;
    const next = events.length > 0 ? events[events.length - 1]!.sequence : after;
    // Stored events are already frozen primitives-only objects: freezing the
    // two arrays and the root is the complete deep freeze, without walking
    // every record on a polling read.
    return deepFreeze({
      version: 1 as const,
      instanceId: this.#instanceId,
      events: Object.freeze(events),
      next,
      lost,
      closed: false,
    });
  }

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  /** Application start has begun. */
  markStarting(): void {
    this.#transition('starting');
  }

  /** Startup completed; the application is serving. */
  markRunning(): void {
    this.#transition('running');
  }

  /** Shutdown has begun; the application is about to refuse requests. */
  markStopping(): void {
    this.#transition('stopping');
  }

  /**
   * Startup failed. Terminal: clears every retained node/edge/event buffer
   * while preserving the caller's original error, so a reader sees only the
   * coarse state, the failure code, and counters.
   */
  markStartupFailed(): void {
    if (this.#state === 'failed' || this.#state === 'closed') {
      return;
    }
    this.#failureCode = 'startup-failed';
    this.#transition('failed');
    this.#clearRetained();
  }

  /**
   * Shutdown finished (successfully or not). Terminal, like
   * {@linkcode markStartupFailed}: retained buffers are cleared regardless of
   * the outcome.
   *
   * @param shutdownFailed - `true` when a shutdown-phase hook rejected
   */
  markClosed(shutdownFailed: boolean): void {
    if (this.#state === 'failed' || this.#state === 'closed') {
      return;
    }
    this.#failureCode = shutdownFailed ? 'shutdown-failed' : null;
    this.#transition('closed');
    this.#ring.close();
    this.#clearRetained();
  }

  /**
   * Records runtime availability: the monotonic origin starts here and the
   * instance UUID is generated once, through the registered runtime. Both are
   * guarded — a failing runtime reports as unavailable (`null` timings, `null`
   * instanceId) rather than turning startup into a diagnostics fault. Before
   * this call, every timing is `null` and none is ever fabricated.
   *
   * @param runtime - The registered runtime services
   * @param telemetryReader - Resolves the telemetry service WITHOUT resolving
   * a lazy factory; `undefined` identifiers are reported as absence
   */
  initializeRuntime(
    runtime: { readonly uuid: () => string; readonly hrtime: () => number },
    telemetryReader: (() => TraceReadingTelemetry | undefined) | undefined,
  ): void {
    // Idempotent: the FIRST runtime registration starts the epoch, and a
    // later call (the step-4 fallback) cannot re-mint the identity.
    if (this.#runtimeInitialized) {
      return;
    }
    this.#runtimeInitialized = true;
    try {
      this.#instanceId = runtime.uuid();
    } catch {
      this.#instanceId = null;
    }
    try {
      const origin = runtime.hrtime();
      this.#clock = (): number | null => {
        try {
          return runtime.hrtime() - origin;
        } catch {
          return null;
        }
      };
    } catch {
      this.#clock = undefined;
    }
    this.#telemetryReader = telemetryReader;
    this.#snapshotDirty = true;
  }

  // ---------------------------------------------------------------------------
  // Observation boundary
  // ---------------------------------------------------------------------------

  /**
   * The one inspection boundary every capture passes through. An event-scope
   * failure disables further event capture after saturating the drop counter;
   * a topology-scope failure drops that entry and marks the snapshot
   * truncated. Neither can propagate: an inspection failure must not change a
   * response, a lifecycle result, or a startup error.
   *
   * @param scope - Which capture family the callback belongs to
   * @param emit - The capture work
   * @returns The callback's value, or `undefined` when it failed
   */
  safeObserve<T>(scope: 'event' | 'topology', emit: () => T): T | undefined {
    try {
      return emit();
    } catch {
      if (scope === 'event') {
        this.#eventCaptureDisabled = true;
        this.#noteDroppedEvent();
      } else {
        this.#topologyTruncated = true;
        this.#snapshotDirty = true;
      }
      return undefined;
    }
  }

  /** Guarded monotonic offset in ms from runtime initialization, or `null`. */
  monotonicMs(): number | null {
    const clock = this.#clock;
    return clock === undefined ? null : clock();
  }

  // ---------------------------------------------------------------------------
  // Topology capture
  // ---------------------------------------------------------------------------

  /**
   * Captures one plugin at its registration boundary: the node plus its
   * DECLARED dependency edges. Names are projected through the allowlists
   * here, at capture — the collector never stores a label that was not
   * explicitly approved.
   *
   * @param info - The declared plugin description
   * @returns The plugin node id, or `undefined` when the capture was dropped
   */
  pluginRegistered(info: PluginRegistrationInfo): string | undefined {
    return this.safeObserve('topology', () => {
      const id = this.#nextNodeId('p', this.#pluginCounter, (next) => {
        this.#pluginCounter = next;
      });
      if (id === undefined) {
        return undefined;
      }
      const label = approvedLabel(this.#labels.plugins, info.name);
      const version = boundedPluginVersion(info.version);
      const node: NodeRecord = {
        id,
        kind: 'plugin',
        ...(label !== undefined ? { label } : {}),
        ...(version !== undefined ? { version } : {}),
      };
      this.#nodes.push(node);
      this.#pluginNodesByName.set(info.name, node);
      this.#snapshotDirty = true;
      this.#declareEdges(id, 'provides', info.provides);
      this.#declareEdges(id, 'requires', info.requires);
      this.#declareEdges(id, 'optional', info.optionalDependencies);
      this.#declareEdges(id, 'consumes', info.consumes);
      return id;
    });
  }

  /**
   * Observes a successful registry registration (instance, factory, or
   * multi-provider) or removal, using token metadata alone. The registry's
   * existing logging observer is untouched.
   *
   * @param event - The registry's registration event
   * @param owner - The plugin whose `register()` was running, when known
   */
  capabilityRegistrationObserved(event: RegistryDiagnosticEvent, owner: string | undefined): void {
    this.safeObserve('topology', () => {
      const node = this.#capabilityNodeFor(event.token);
      if (event.kind === 'unregister') {
        node.registered = false;
      } else {
        node.registered = true;
        const ownerNode = owner === undefined ? undefined : this.#pluginNodesByName.get(owner);
        if (ownerNode !== undefined) {
          this.#addEdge(ownerNode.id, node.id, 'owns');
        }
      }
      this.#snapshotDirty = true;
    });
  }

  /**
   * Captures one route registration with its route-middleware nodes.
   *
   * @param event - The router's registration event
   * @returns The route node id, or `undefined` when the capture was dropped
   */
  routeRegistered(event: RouteRegistrationEvent): string | undefined {
    return this.safeObserve('topology', () => {
      const id = this.#nextNodeId('r', this.#routeCounter, (next) => {
        this.#routeCounter = next;
      });
      if (id === undefined) {
        return undefined;
      }
      const label = approvedLabel(this.#labels.routes, event.pattern);
      const method = projectHttpMethod(event.method);
      const node: NodeRecord = {
        id,
        kind: 'route',
        ...(label !== undefined ? { label } : {}),
        ...(method !== undefined ? { method } : {}),
      };
      this.#nodes.push(node);
      this.#routeNodeIds.set(event.entryIndex, node);
      this.#snapshotDirty = true;
      // Route middleware without an explicit approved name gets only its id
      // and position; function names are never consulted.
      const stages: NodeRecord[] = [];
      for (let position = 1; position <= event.middlewareCount; position++) {
        const stageId = this.#nextNodeId('m', this.#middlewareCounter, (next) => {
          this.#middlewareCounter = next;
        });
        if (stageId === undefined) {
          break;
        }
        const stage: NodeRecord = { id: stageId, kind: 'middleware', position };
        this.#nodes.push(stage);
        stages.push(stage);
      }
      this.#routeMiddlewareNodes.set(event.entryIndex, stages);
      const ownerNode = event.owner === undefined
        ? undefined
        : this.#pluginNodesByName.get(event.owner);
      if (ownerNode !== undefined) {
        this.#addEdge(ownerNode.id, id, 'owns');
      }
      return id;
    });
  }

  /**
   * Captures the compiled global pipeline in execution order — the stable
   * priority sort — so middleware stage records can name their node.
   *
   * @param descriptors - The compiled stages, in execution order
   */
  middlewareCompiled(descriptors: readonly MiddlewareCompiledDescriptor[]): void {
    this.safeObserve('topology', () => {
      const nodes: NodeRecord[] = [];
      for (const descriptor of descriptors) {
        const id = this.#nextNodeId('m', this.#middlewareCounter, (next) => {
          this.#middlewareCounter = next;
        });
        if (id === undefined) {
          break;
        }
        const label = approvedLabel(this.#labels.middleware, descriptor.name);
        const node: NodeRecord = {
          id,
          kind: 'middleware',
          ...(label !== undefined ? { label } : {}),
          priority: descriptor.priority,
          position: descriptor.position,
        };
        this.#nodes.push(node);
        nodes.push(node);
      }
      this.#globalMiddlewareNodes.push(...nodes);
      this.#snapshotDirty = true;
    });
  }

  /** Route node id for a router entry index, when that route was captured. */
  routeNodeIdOf(entryIndex: number): string | undefined {
    return this.#routeNodeIds.get(entryIndex)?.id;
  }

  // ---------------------------------------------------------------------------
  // Execution capture
  // ---------------------------------------------------------------------------

  /**
   * Allocates an operation root at entry. The identifier exists before any
   * record is written, so a child may reference a parent whose completion
   * record appears later.
   *
   * @returns The operation handle
   */
  beginOperation(): DiagnosticsOperation {
    return {
      id: this.#nextOperationId(),
      startedAtMs: this.monotonicMs(),
    };
  }

  /**
   * Allocates the request operation for a context, stored in a private
   * WeakMap — never in application state, never a caller-supplied id.
   *
   * @param ctx - The request context keying the operation
   */
  beginRequestOperation(ctx: object): void {
    this.#requestOperations.set(ctx, this.beginOperation());
  }

  /**
   * Emits the request operation's completion record.
   *
   * @param ctx - The request context keying the operation
   * @param parts - Outcome and the produced status code
   */
  endRequestOperation(
    ctx: object,
    parts: { outcome: DiagnosticsEventOutcome; statusCode?: number },
  ): void {
    const operation = this.#requestOperations.get(ctx);
    if (operation === undefined) {
      return;
    }
    this.#requestOperations.delete(ctx);
    this.#emitEvent({
      kind: 'request',
      stage: 'request',
      operationId: operation.id,
      parentOperationId: null,
      nodeId: null,
      outcome: parts.outcome,
      startedAtMs: operation.startedAtMs,
      durationMs: this.#durationSince(operation.startedAtMs),
      ...(parts.statusCode !== undefined ? { statusCode: parts.statusCode } : {}),
      withTrace: true,
    });
  }

  /**
   * Emits one middleware stage completion record (global or route chain).
   *
   * @param parts - The stage observation from the chain executor
   */
  observeMiddlewareStage(parts: {
    parentOperationId: string;
    scope: 'global' | 'route';
    position: number;
    routeEntryIndex: number | undefined;
    outcome: DiagnosticsEventOutcome;
    startedAtMs: number | null;
    durationMs: number | null;
  }): void {
    const node = parts.scope === 'global'
      ? this.#globalMiddlewareNodes[parts.position]?.id
      : this.#routeMiddlewareNodes.get(parts.routeEntryIndex ?? -1)?.[parts.position]?.id;
    this.#emitEvent({
      kind: 'middleware',
      stage: parts.scope,
      operationId: this.#nextOperationId(),
      parentOperationId: parts.parentOperationId,
      nodeId: node ?? null,
      outcome: parts.outcome,
      startedAtMs: parts.startedAtMs,
      durationMs: parts.durationMs,
    });
  }

  /**
   * Emits one handler or protocol-boundary completion record.
   *
   * @param parts - The handler observation
   */
  observeHandlerStage(parts: {
    parentOperationId: string;
    stage: 'handler' | 'websocket-upgrade' | 'grpc-dispatch';
    nodeId: string | null;
    outcome: DiagnosticsEventOutcome;
    startedAtMs: number | null;
    durationMs: number | null;
    statusCode?: number;
  }): void {
    this.#emitEvent({
      kind: 'handler',
      stage: parts.stage,
      operationId: this.#nextOperationId(),
      parentOperationId: parts.parentOperationId,
      nodeId: parts.nodeId,
      outcome: parts.outcome,
      startedAtMs: parts.startedAtMs,
      durationMs: parts.durationMs,
      ...(parts.statusCode !== undefined ? { statusCode: parts.statusCode } : {}),
      withTrace: true,
    });
  }

  /**
   * Emits one request-scoped hook completion record (`request-hook`,
   * `response-hook`, `error-hook`).
   *
   * @param parts - The hook observation
   */
  observeRequestStage(parts: {
    parentOperationId: string;
    stage: 'request-hook' | 'response-hook' | 'error-hook';
    outcome: DiagnosticsEventOutcome;
    startedAtMs: number | null;
    durationMs: number | null;
  }): void {
    this.#emitEvent({
      kind: 'request',
      stage: parts.stage,
      operationId: this.#nextOperationId(),
      parentOperationId: parts.parentOperationId,
      nodeId: null,
      outcome: parts.outcome,
      startedAtMs: parts.startedAtMs,
      durationMs: parts.durationMs,
    });
  }

  /**
   * Emits one lifecycle completion record for an operation allocated at entry
   * with {@linkcode beginOperation}.
   *
   * @param operation - The operation allocated at the boundary's entry
   * @param stage - The lifecycle boundary that completed
   * @param nodeId - The plugin node the boundary belongs to, when known
   * @param outcome - How the boundary completed
   */
  observeLifecycleEvent(
    operation: DiagnosticsOperation,
    stage: DiagnosticsEventStage,
    nodeId: string | null,
    outcome: DiagnosticsEventOutcome,
  ): void {
    this.#emitEvent({
      kind: 'lifecycle',
      stage,
      operationId: operation.id,
      parentOperationId: null,
      nodeId,
      outcome,
      startedAtMs: operation.startedAtMs,
      durationMs: this.elapsedSince(operation.startedAtMs),
    });
  }

  /**
   * Emits one per-hook lifecycle record observed by the lifecycle manager —
   * fixed phase plus execution ordinal, never an inferred owner.
   *
   * @param observation - The manager's hook observation
   */
  observeLifecycleHook(observation: {
    phase: 'register-hook' | 'init' | 'bootstrap' | 'stopping' | 'shutdown' | 'close';
    ordinal: number;
    failed: boolean;
    startedAtMs: number | null;
    durationMs: number | null;
  }): void {
    this.#emitEvent({
      kind: 'lifecycle',
      stage: observation.phase,
      operationId: this.#nextOperationId(),
      parentOperationId: null,
      nodeId: null,
      outcome: observation.failed ? 'error' : 'ok',
      startedAtMs: observation.startedAtMs,
      durationMs: observation.durationMs,
    });
  }

  /**
   * The request operation identifier keyed to a context, when one exists.
   *
   * @param ctx - The request context the operation was keyed under
   * @returns The operation id, or `undefined`
   */
  requestOperationIdOf(ctx: object): string | undefined {
    return this.#requestOperations.get(ctx)?.id;
  }

  /**
   * Inclusive monotonic elapsed time since a recorded start offset.
   *
   * @param startedAtMs - The recorded start offset, or `null`
   * @returns Elapsed ms, or `null` when either reading was unavailable
   */
  elapsedSince(startedAtMs: number | null): number | null {
    return this.#durationSince(startedAtMs);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  #transition(state: DiagnosticsSnapshotState): void {
    if (this.#state === 'failed' || this.#state === 'closed') {
      return;
    }
    this.#state = state;
    this.#snapshotDirty = true;
  }

  #clearRetained(): void {
    this.#nodes.length = 0;
    this.#edges.length = 0;
    this.#edgeKeys.clear();
    this.#pluginNodesByName.clear();
    this.#capabilityNodesByToken.clear();
    this.#routeNodeIds.clear();
    this.#routeMiddlewareNodes.clear();
    this.#globalMiddlewareNodes.length = 0;
    this.#ring.clear();
    this.#cachedSnapshot = undefined;
    this.#snapshotDirty = true;
  }

  #nextNodeId(
    prefix: string,
    current: number,
    assign: (next: number) => void,
  ): string | undefined {
    // Fixed v1 limit: stop ADDING topology at 1,024 nodes and report the
    // truncation rather than retaining unbounded metadata.
    if (this.#nodes.length >= MAX_NODES) {
      this.#topologyTruncated = true;
      this.#snapshotDirty = true;
      return undefined;
    }
    const next = saturatingNext(current);
    if (next === null) {
      this.#topologyTruncated = true;
      this.#snapshotDirty = true;
      return undefined;
    }
    assign(next);
    return `${prefix}${next}`;
  }

  #nextOperationId(): string {
    // Saturation here is unreachable within any real run; the guard exists so
    // a hostile synthetic workload stops event capture instead of minting a
    // wrapped identifier.
    const next = saturatingNext(this.#opCounter);
    if (next === null) {
      this.#eventCaptureDisabled = true;
      return 'op0';
    }
    this.#opCounter = next;
    return `op${next}`;
  }

  #capabilityNodeFor(token: string): NodeRecord {
    const existing = this.#capabilityNodesByToken.get(token);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.#nextNodeId('c', this.#capabilityCounter, (next) => {
      this.#capabilityCounter = next;
    });
    if (id === undefined) {
      // Node cap reached: return a detached record so the caller's mutation
      // stays value-free; edges to it are omitted because its id is unknown.
      return { id: '', kind: 'capability' };
    }
    const label = approvedLabel(this.#labels.capabilities, token);
    const node: NodeRecord = {
      id,
      kind: 'capability',
      ...(label !== undefined ? { label } : {}),
      registered: false,
    };
    this.#nodes.push(node);
    this.#capabilityNodesByToken.set(token, node);
    this.#snapshotDirty = true;
    return node;
  }

  #declareEdges(pluginId: string, kind: DiagnosticsEdgeKind, tokens: readonly string[]): void {
    for (const token of tokens) {
      const capability = this.#capabilityNodeFor(token);
      if (capability.id !== '') {
        this.#addEdge(pluginId, capability.id, kind);
      }
    }
  }

  #addEdge(from: string, to: string, kind: DiagnosticsEdgeKind): void {
    // Edges whose endpoints were dropped (node cap) are omitted, never dangling.
    if (from === '' || to === '') {
      return;
    }
    const key = `${from}|${to}|${kind}`;
    if (this.#edgeKeys.has(key)) {
      return;
    }
    if (this.#edges.length >= MAX_EDGES) {
      this.#topologyTruncated = true;
      this.#snapshotDirty = true;
      return;
    }
    this.#edgeKeys.add(key);
    this.#edges.push({ from, to, kind });
    this.#snapshotDirty = true;
  }

  #noteDroppedEvent(): void {
    const next = saturatingNext(this.#droppedEvents);
    this.#droppedEvents = next ?? Number.MAX_SAFE_INTEGER;
    this.#snapshotDirty = true;
  }

  #durationSince(startedAtMs: number | null): number | null {
    if (startedAtMs === null) {
      return null;
    }
    const finishedAtMs = this.monotonicMs();
    return finishedAtMs === null ? null : finishedAtMs - startedAtMs;
  }

  #traceIdentifiers(): TraceIdentifiers {
    const reader = this.#telemetryReader;
    if (reader === undefined) {
      return {};
    }
    let service: TraceReadingTelemetry | undefined;
    try {
      service = reader();
    } catch {
      return {};
    }
    const activeSpanContext = service?.activeSpanContext;
    if (activeSpanContext === undefined) {
      return {};
    }
    let context: { readonly traceId: string; readonly spanId: string } | undefined;
    try {
      context = activeSpanContext.call(service);
    } catch {
      return {};
    }
    if (context === undefined) {
      return {};
    }
    // Identifiers are carried only when they are well-formed and non-zero —
    // the W3C all-zero ids mean "invalid", not "anonymous".
    const traceId = TRACE_ID_PATTERN.test(context.traceId) && NON_ZERO.test(context.traceId)
      ? context.traceId
      : undefined;
    const spanId = SPAN_ID_PATTERN.test(context.spanId) && NON_ZERO.test(context.spanId)
      ? context.spanId
      : undefined;
    return {
      ...(traceId !== undefined ? { traceId } : {}),
      ...(spanId !== undefined ? { spanId } : {}),
    };
  }

  /**
   * The terminal observation boundary: the one place an event is built and
   * stored, so an event-capture failure disables capture exactly once and
   * never propagates into a response, a lifecycle result, or a startup error.
   *
   * @param parts - The completion record to emit
   */
  #emitEvent(parts: CompletionRecordParts): void {
    if (this.#eventCaptureDisabled || this.#ring.closed) {
      return;
    }
    try {
      this.#buildAndStoreEvent(parts);
    } catch {
      this.#eventCaptureDisabled = true;
      this.#noteDroppedEvent();
    }
  }

  #buildAndStoreEvent(parts: CompletionRecordParts): void {
    const identifiers = parts.withTrace === true ? this.#traceIdentifiers() : {};
    // The byte cap is enforced BEFORE serialization (§3.6): every field is a
    // collector-owned bounded string, so the structural bound decides, and
    // an oversized event is dropped WHOLE without ever building it.
    const traceId = identifiers.traceId;
    const spanId = identifiers.spanId;
    const parentLength = parts.parentOperationId?.length ?? 0;
    const withinCap = eventWithinByteCap({
      operationId: parts.operationId.length,
      parentOperationId: parentLength,
      nodeId: parts.nodeId?.length ?? 0,
      traceId: traceId?.length ?? 0,
      spanId: spanId?.length ?? 0,
      statusCode: parts.statusCode !== undefined,
    });
    if (
      parts.operationId.length > MAX_EVENT_FIELD_LENGTH ||
      parentLength > MAX_EVENT_FIELD_LENGTH ||
      (parts.nodeId?.length ?? 0) > MAX_EVENT_FIELD_LENGTH ||
      !withinCap
    ) {
      this.#noteDroppedEvent();
      return;
    }
    const sequence = this.#ring.allocateSequence();
    if (sequence === null) {
      this.#eventCaptureDisabled = true;
      this.#noteDroppedEvent();
      return;
    }
    // Fields are primitives only, so a shallow freeze is the deep freeze.
    const event: DiagnosticsEvent = Object.freeze({
      sequence,
      operationId: parts.operationId,
      parentOperationId: parts.parentOperationId,
      kind: parts.kind,
      stage: parts.stage,
      nodeId: parts.nodeId,
      outcome: parts.outcome,
      atMs: parts.startedAtMs,
      durationMs: parts.durationMs,
      ...(parts.statusCode !== undefined ? { statusCode: parts.statusCode } : {}),
      ...(traceId !== undefined ? { traceId } : {}),
      ...(spanId !== undefined ? { spanId } : {}),
    });
    this.#ring.store(sequence, event);
  }
}

function nodeToDto(node: NodeRecord): DiagnosticsNode {
  return {
    id: node.id,
    kind: node.kind,
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.version !== undefined ? { version: node.version } : {}),
    ...(node.method !== undefined ? { method: node.method } : {}),
    ...(node.priority !== undefined ? { priority: node.priority } : {}),
    ...(node.position !== undefined ? { position: node.position } : {}),
    ...(node.registered !== undefined ? { registered: node.registered } : {}),
  };
}

function edgeToDto(edge: EdgeRecord): DiagnosticsEdge {
  return { from: edge.from, to: edge.to, kind: edge.kind };
}
