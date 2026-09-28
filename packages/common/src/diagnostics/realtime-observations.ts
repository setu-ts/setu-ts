/**
 * The one realtime observation collector (M98l), shared by the WebSocket, SSE
 * and realtime-backplane plugins.
 *
 * It lives in `common` because the three owning plugins need exactly the same
 * collector and may not import one another (AI_GUIDELINES §2.2): the
 * alternative was three copies (§11.1). It is a pure, bounded object — no I/O,
 * no registry access, no timer — so exposing it costs nothing a caller could
 * misuse: an application that constructs one builds a collector nobody reads.
 *
 * The collector is the minimization seam. Its entry points accept a fixed
 * operation and booleans, and one promise-returning callback whose result is
 * passed through untouched. A frame, a message, a close reason, a name, an
 * identifier or a thrown value has no parameter to arrive through.
 *
 * @module
 * @since 0.8.0
 */

import type {
  DiagnosticsInspectorState,
  IRealtimeDiagnosticsSource,
  RealtimeDiagnosticsGauges,
  RealtimeDiagnosticsRecord,
  RealtimeDiagnosticsSnapshot,
  RealtimeObservationOperation,
  RealtimeSourceKind,
} from '../services/diagnostics.ts';

/**
 * The `diagnostics` option the WebSocket, SSE and realtime-backplane plugins
 * accept (M98l). Absent means the plugin registers an inert `disabled` source
 * and observes nothing.
 *
 * `alias` is an explicit, non-secret display label for the one component the
 * plugin owns: 1–64 UTF-8 bytes, no control character, and unique among the
 * realtime sources of one application (the connector refuses a duplicate at
 * read time). Approving an alias authorizes its disclosure to a paired
 * devtool; never derive one from a secret, a user id or a tenant id.
 *
 * @since 0.8.0
 */
export interface RealtimeDiagnosticsOptions {
  /** Must be the literal `true`; omit the option instead of passing `false`. */
  readonly enabled: true;
  /** The approved display alias for this plugin's component. */
  readonly alias: string;
}

/**
 * A current-state reading of the owning service's two gauges.
 *
 * @since 0.8.0
 */
export interface RealtimeGaugeReading {
  /** Connections the service currently holds open. */
  readonly openConnections: number;
  /** Rooms or channels the service currently holds. */
  readonly groups: number;
}

/**
 * How a plugin constructs its collector.
 *
 * @since 0.8.0
 */
export interface RealtimeObservationCollectorInit {
  /** The kind of component the plugin owns; fixed for the collector's life. */
  readonly kind: RealtimeSourceKind;
  /**
   * The alias {@linkcode compileRealtimeDiagnosticsAlias} returned, or `null`
   * when the plugin was not opted in (the collector is then inert and answers
   * `disabled`).
   */
  readonly alias: string | null;
  /** The runtime's monotonic clock in milliseconds (`runtime.hrtime`). */
  readonly clock: () => number;
  /**
   * Reads the plugin's OWN service's size getters. Required for `websocket`
   * and `sse`; ignored for `backplane`, which has no gauges. Called only by
   * `snapshot()` on an enabled, healthy source, and released by `close()`.
   */
  readonly gauges?: () => RealtimeGaugeReading;
}

/**
 * The collector a realtime plugin attaches to its component. It answers
 * `snapshot()` itself; the plugin registers its frozen {@linkcode source}
 * facade, which exposes `snapshot()` alone.
 *
 * Every entry point is non-throwing and never changes the application's
 * result: a failing clock or gauge reader latches `collection-failed`, clears
 * the records and stops capture until the plugin is recreated.
 *
 * @since 0.8.0
 */
export interface IRealtimeObservationCollector extends IRealtimeDiagnosticsSource {
  /** `true` when opted in and not yet closed; a capture site skips work when `false`. */
  readonly enabled: boolean;
  /**
   * The frozen, snapshot-only facade a plugin registers under
   * `CAPABILITIES.REALTIME_DIAGNOSTICS`. Registering the collector itself
   * would hand every registry reader its `observe` and `close`.
   */
  readonly source: IRealtimeDiagnosticsSource;
  /**
   * Records one instantaneous observation. An operation the collector's kind
   * does not admit is ignored.
   *
   * @param operation - The fixed operation
   * @param succeeded - Whether it completed normally
   * @param backpressure - For an `sse` `close`, whether the backlog guard caused it
   */
  observe(
    operation: RealtimeObservationOperation,
    succeeded: boolean,
    backpressure?: boolean,
  ): void;
  /**
   * Runs one backplane publication and records it as `backplane-publish` with
   * its duration. The returned promise settles with the SAME value or the
   * SAME rejection reason as the call's, so an unhandled rejection stays
   * unhandled. A synchronous throw is recorded as failed and rethrown.
   *
   * @param call - Invokes the transport's publish
   * @returns A promise derived from the call's
   */
  observePublish<T>(call: () => Promise<T>): Promise<T>;
  /**
   * Marks the collector closed FIRST, so a late observation is discarded,
   * then clears every record and releases the gauge reader. Idempotent.
   */
  close(): void;
}

/**
 * The fixed, value-free option refusals. None echoes a supplied value.
 *
 * @internal
 */
export const REALTIME_DIAGNOSTICS_ERRORS = {
  shape: 'Realtime diagnostics: options must be an object { enabled: true, alias }.',
  enabled: 'Realtime diagnostics: enabled must be the literal true; omit diagnostics instead.',
  aliasType: 'Realtime diagnostics: alias must be a string.',
  aliasBytes: 'Realtime diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Realtime diagnostics: an alias contains a control character.',
  extraKey: 'Realtime diagnostics: options accept only enabled and alias.',
  gauges: 'Realtime diagnostics: a websocket or sse collector needs a gauge reader.',
} as const;

/**
 * The fixed collector bounds. Constants, not options.
 *
 * @internal
 */
export const REALTIME_COLLECTOR_LIMITS = {
  /** Maximum UTF-8 bytes of the approved alias. */
  aliasBytes: 64,
  /** A record older than this (ms since its last observation) is expired and cleared. */
  retentionMs: 60_000,
  /** A backplane source whose every record is older than this (ms) is `stale`. */
  staleMs: 30_000,
} as const;

/** The operations each kind admits, in the fixed order records are reported in. */
const KIND_OPERATIONS: Readonly<
  Record<RealtimeSourceKind, readonly RealtimeObservationOperation[]>
> = {
  websocket: ['open', 'close', 'send'],
  sse: ['open', 'close', 'send'],
  backplane: ['backplane-publish', 'backplane-receive'],
};

const OPTION_KEYS: ReadonlySet<string> = new Set(['enabled', 'alias']);

const ENCODER = new TextEncoder();

/**
 * Reports whether a string carries a C0/C1 control code point.
 *
 * @param value - The string to scan
 * @returns `true` when any code point is in U+0000–U+001F or U+007F–U+009F
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates the realtime `diagnostics` option and returns the approved alias
 * — the ONE validation of this option, which the three owning plugin
 * factories call when the plugin is constructed, so an invalid option refuses
 * before any application exists. `enabled` is checked at runtime, not only by
 * its literal type, so a configuration-driven `enabled: false` is refused
 * rather than silently opted in.
 *
 * @param options - The supplied option
 * @returns The approved display alias
 * @throws {TypeError} When the option is not an object, carries another key,
 * `enabled` is not `true`, or `alias` is not a string — with a fixed,
 * value-free message
 * @throws {RangeError} When the alias is outside 1–64 UTF-8 bytes or carries a
 * control character
 * @example
 * ```typescript
 * const alias = compileRealtimeDiagnosticsAlias({ enabled: true, alias: 'chat' });
 * ```
 * @since 0.8.0
 */
export function compileRealtimeDiagnosticsAlias(options: RealtimeDiagnosticsOptions): string {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(REALTIME_DIAGNOSTICS_ERRORS.shape);
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(REALTIME_DIAGNOSTICS_ERRORS.extraKey);
    }
  }
  if (options.enabled !== true) {
    throw new TypeError(REALTIME_DIAGNOSTICS_ERRORS.enabled);
  }
  const alias: unknown = options.alias;
  if (typeof alias !== 'string') {
    throw new TypeError(REALTIME_DIAGNOSTICS_ERRORS.aliasType);
  }
  const bytes = ENCODER.encode(alias).length;
  if (bytes < 1 || bytes > REALTIME_COLLECTOR_LIMITS.aliasBytes) {
    throw new RangeError(REALTIME_DIAGNOSTICS_ERRORS.aliasBytes);
  }
  if (hasControlCharacter(alias)) {
    throw new RangeError(REALTIME_DIAGNOSTICS_ERRORS.aliasControl);
  }
  return alias;
}

/** The mutable counters behind one record. */
interface MutableRecord {
  count: number;
  succeeded: number;
  failed: number;
  backpressureCloses: number;
  lastDurationMs: number | null;
  lastAt: number;
}

/**
 * Saturating increment: every counter clamps at `Number.MAX_SAFE_INTEGER`.
 *
 * @param value - The current counter
 * @returns The incremented, clamped counter
 * @internal
 */
export function bump(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

/** Clamps a measurement to a non-negative integer millisecond count. */
function clampMs(raw: number): number {
  const ms = Math.floor(raw);
  return ms > 0 ? Math.min(ms, Number.MAX_SAFE_INTEGER) : 0;
}

/** A non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The frozen gauges of a source whose values were not obtained. */
function unreadGauges(
  state: 'unsupported' | 'disabled' | 'collection-failed',
): RealtimeDiagnosticsGauges {
  return Object.freeze({ state, openConnections: null, groups: null });
}

/**
 * The bounded collector. At most one record per operation its kind admits
 * (three for websocket and sse, two for a backplane), so no observation is
 * ever dropped for want of a slot and `dropped` stays `0`.
 */
class RealtimeObservationCollector implements IRealtimeObservationCollector {
  readonly #kind: RealtimeSourceKind;
  readonly #alias: string | null;
  readonly #clock: () => number;
  readonly #admitted: ReadonlySet<RealtimeObservationOperation>;
  readonly #records = new Map<RealtimeObservationOperation, MutableRecord>();
  #gauges: (() => RealtimeGaugeReading) | undefined;
  #failed = false;
  #closed = false;
  readonly source: IRealtimeDiagnosticsSource = Object.freeze({
    snapshot: (): RealtimeDiagnosticsSnapshot => this.snapshot(),
  });

  constructor(init: RealtimeObservationCollectorInit) {
    this.#kind = init.kind;
    this.#alias = init.alias;
    this.#clock = init.clock;
    this.#admitted = new Set(KIND_OPERATIONS[init.kind]);
    this.#gauges = init.kind === 'backplane' ? undefined : init.gauges;
  }

  get enabled(): boolean {
    return this.#alias !== null && !this.#closed && !this.#failed;
  }

  observe(operation: RealtimeObservationOperation, succeeded: boolean, backpressure = false): void {
    if (!this.enabled || !this.#admitted.has(operation)) {
      return;
    }
    const now = this.#read();
    if (now === null) {
      return;
    }
    this.#record(operation, succeeded, backpressure, null, now);
  }

  observePublish<T>(call: () => Promise<T>): Promise<T> {
    if (!this.enabled || !this.#admitted.has('backplane-publish')) {
      return call();
    }
    const start = this.#read();
    let pending: Promise<T>;
    try {
      pending = call();
    } catch (error) {
      this.#settlePublish(start, false);
      throw error;
    }
    // A DERIVED promise that re-rejects with the original reason. A side
    // branch on the caller's own promise would mark it handled, so a
    // fire-and-forget publish whose transport rejects would stop surfacing as
    // an unhandled rejection whenever diagnostics are on (the M98i lesson).
    return pending.then(
      (value) => {
        this.#settlePublish(start, true);
        return value;
      },
      (reason: unknown) => {
        this.#settlePublish(start, false);
        throw reason;
      },
    );
  }

  /** Records a settled publication measured from `start`. */
  #settlePublish(start: number | null, succeeded: boolean): void {
    if (start === null || !this.enabled) {
      return;
    }
    const now = this.#read();
    if (now === null) {
      return;
    }
    this.#record('backplane-publish', succeeded, false, clampMs(now - start), now);
  }

  /** Reads the clock once; a failure latches `collection-failed`. */
  #read(): number | null {
    try {
      const now = this.#clock();
      if (typeof now !== 'number' || !Number.isFinite(now)) {
        this.#fail();
        return null;
      }
      return now;
    } catch {
      this.#fail();
      return null;
    }
  }

  /** Applies one settled observation to its record, resetting an expired one. */
  #record(
    operation: RealtimeObservationOperation,
    succeeded: boolean,
    backpressure: boolean,
    durationMs: number | null,
    now: number,
  ): void {
    let record = this.#records.get(operation);
    if (
      record === undefined ||
      now - record.lastAt > REALTIME_COLLECTOR_LIMITS.retentionMs
    ) {
      record = {
        count: 0,
        succeeded: 0,
        failed: 0,
        backpressureCloses: 0,
        lastDurationMs: null,
        lastAt: now,
      };
      this.#records.set(operation, record);
    }
    record.count = bump(record.count);
    if (succeeded) {
      record.succeeded = bump(record.succeeded);
    } else {
      record.failed = bump(record.failed);
      if (backpressure && this.#kind === 'sse' && operation === 'close') {
        record.backpressureCloses = bump(record.backpressureCloses);
      }
    }
    if (durationMs !== null) {
      record.lastDurationMs = durationMs;
    }
    // Never moved backwards: `ageMs` is time since the most recent observation.
    record.lastAt = Math.max(record.lastAt, now);
  }

  /** Latches `collection-failed`, discarding every record and the gauge reader. */
  #fail(): void {
    this.#failed = true;
    this.#records.clear();
    this.#gauges = undefined;
  }

  close(): void {
    this.#closed = true;
    this.#records.clear();
    this.#gauges = undefined;
  }

  snapshot(): RealtimeDiagnosticsSnapshot {
    if (this.#alias === null || this.#closed) {
      return this.#frozen('disabled', null, unreadGauges('disabled'), []);
    }
    if (this.#failed) {
      return this.#failedSnapshot();
    }
    const now = this.#read();
    if (now === null) {
      return this.#failedSnapshot();
    }
    let gauges: RealtimeDiagnosticsGauges;
    if (this.#kind === 'backplane') {
      gauges = unreadGauges('unsupported');
    } else {
      const reading = this.#readGauges();
      if (reading === null) {
        return this.#failedSnapshot();
      }
      gauges = Object.freeze({
        state: 'available' as const,
        openConnections: reading.openConnections,
        groups: reading.groups,
      });
    }
    const records: RealtimeDiagnosticsRecord[] = [];
    let freshest = Number.POSITIVE_INFINITY;
    for (const operation of KIND_OPERATIONS[this.#kind]) {
      const record = this.#records.get(operation);
      if (record === undefined) {
        continue;
      }
      const age = Math.max(0, now - record.lastAt);
      if (age > REALTIME_COLLECTOR_LIMITS.retentionMs) {
        this.#records.delete(operation);
        continue;
      }
      freshest = Math.min(freshest, age);
      records.push(Object.freeze({
        alias: this.#alias,
        operation,
        count: record.count,
        lastDurationMs: operation === 'backplane-publish' ? record.lastDurationMs : null,
        ageMs: clampMs(age),
        succeeded: record.succeeded,
        failed: record.failed,
        backpressureCloses: this.#kind === 'sse' && operation === 'close'
          ? record.backpressureCloses
          : null,
      }));
    }
    // A websocket or sse source is ready whenever its gauges were read — the
    // gauges are current even when no operation happened in 60 seconds. A
    // backplane has no gauges, so its readiness comes from record age alone.
    let state: DiagnosticsInspectorState = 'ready';
    if (this.#kind === 'backplane') {
      state = records.length === 0
        ? 'no-data'
        : freshest > REALTIME_COLLECTOR_LIMITS.staleMs
        ? 'stale'
        : 'ready';
    }
    return this.#frozen(state, this.#alias, gauges, records);
  }

  /**
   * Calls the gauge reader once and validates both values. A throw or a value
   * outside the non-negative safe integers latches `collection-failed`.
   */
  #readGauges(): RealtimeGaugeReading | null {
    const reader = this.#gauges;
    try {
      const reading = reader!();
      const openConnections = reading.openConnections;
      const groups = reading.groups;
      if (!isCount(openConnections) || !isCount(groups)) {
        this.#fail();
        return null;
      }
      return { openConnections, groups };
    } catch {
      this.#fail();
      return null;
    }
  }

  /** The latched snapshot: fixed kind and approved alias, no records, failed gauges. */
  #failedSnapshot(): RealtimeDiagnosticsSnapshot {
    return this.#frozen('collection-failed', this.#alias, unreadGauges('collection-failed'), []);
  }

  #frozen(
    state: DiagnosticsInspectorState,
    alias: string | null,
    gauges: RealtimeDiagnosticsGauges,
    records: RealtimeDiagnosticsRecord[],
  ): RealtimeDiagnosticsSnapshot {
    return Object.freeze({
      state,
      alias,
      sourceKind: this.#kind,
      coverage: 'owned-instance' as const,
      gauges,
      records: Object.freeze(records),
      dropped: 0,
    });
  }
}

/**
 * Creates the collector a WebSocket, SSE or realtime-backplane plugin attaches
 * to its own component and registers as its realtime diagnostics source
 * (M98l). With a `null` alias it is inert: it observes nothing, never reads
 * the clock or the gauges, and answers a `disabled` snapshot.
 *
 * @param init - The component kind, approved alias, clock and gauge reader
 * @returns The collector; register its `source` facade, never the collector
 * @throws {TypeError} When an enabled `websocket` or `sse` collector is given
 * no gauge reader
 * @example
 * ```typescript
 * const collector = createRealtimeObservationCollector({
 *   kind: 'websocket',
 *   alias: compileRealtimeDiagnosticsAlias({ enabled: true, alias: 'chat' }),
 *   clock: () => ctx.runtime.hrtime(),
 *   gauges: () => ({ openConnections: service.connectionCount, groups: service.roomCount }),
 * });
 * ```
 * @since 0.8.0
 */
export function createRealtimeObservationCollector(
  init: RealtimeObservationCollectorInit,
): IRealtimeObservationCollector {
  if (init.alias !== null && init.kind !== 'backplane' && typeof init.gauges !== 'function') {
    throw new TypeError(REALTIME_DIAGNOSTICS_ERRORS.gauges);
  }
  return new RealtimeObservationCollector(init);
}
