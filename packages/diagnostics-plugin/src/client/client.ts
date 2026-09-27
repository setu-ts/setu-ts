/**
 * The native diagnostics client — the reviewed implementation of protocol
 * v1's client side, consumed by the separately maintained devtool.
 *
 * Every dependency is injected (subtle, fetch, timing): no ambient runtime
 * globals, no new optional dependency. Requests are serialized and reserve
 * unique, strictly increasing sequence numbers — a number is never reused,
 * including after a network failure. Every response is MAC-verified over
 * its exact bounded bytes BEFORE parsing, displaying, or persisting
 * anything, and bodies are read under a hard 256 KiB ceiling with a fixed
 * 5-second abort deadline.
 *
 * @module
 */

import type {
  ConfigDiagnosticsSnapshot,
  DiagnosticsBatch,
  DiagnosticsSnapshot,
  HealthDiagnosticsSnapshot,
  QueueDiagnosticsBatch,
  TraceDiagnosticsBatch,
} from '@setu-ts/common';

import {
  importSessionKey,
  parseMac,
  requestMacFields,
  responseMacFields,
  sha256Hex,
  signFields,
  verifyFields,
} from '../security/authentication.ts';
import type { DiagnosticsClientOptions, IDiagnosticsClient } from '../interfaces/index.ts';
import {
  CONFIG_TARGET,
  HEALTH_TARGET,
  type InspectorsManifest,
  isBatchProjection,
  isConfigSnapshotProjection,
  isHealthSnapshotProjection,
  isSnapshotProjection,
  parseStatusBody,
  QUEUES_PATH,
  SNAPSHOT_TARGET,
  STATUS_TARGET,
  TRACES_PATH,
} from '../protocol/protocol.ts';
import { isQueueBatchProjection } from '../protocol/queue-protocol.ts';
import { isTraceBatchProjection } from '../protocol/trace-protocol.ts';

/**
 * The fixed request deadline, in milliseconds.
 *
 * @internal
 */
const REQUEST_DEADLINE_MS = 5_000;

/**
 * The hard ceiling on any response body, in bytes. `Content-Length` alone
 * is insufficient — the response STREAM is bounded while reading.
 *
 * @internal
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Fixed client errors. None echo server input.
 *
 * @internal
 */
export const CLIENT_ERRORS = {
  endpoint:
    'Diagnostics client: endpoint must be exactly http://127.0.0.1:<port> with no credentials, path, query, or fragment.',
  sessionId: 'Diagnostics client: sessionId must be exactly 32 lowercase hex characters.',
  sessionKey: 'Diagnostics client: sessionKey must be exactly 32 bytes.',
  arguments:
    'Diagnostics client: read(), queues() and traces() require a non-negative safe-integer cursor and a limit from 1 to 128.',
  closed: 'Diagnostics client: the client is closed.',
  pairingFailed:
    'Diagnostics client: pairing failed terminally; relaunch the application and create a new session.',
  connection:
    'Diagnostics client: the connection failed verification or bounds; treat as a connection failure.',
  exhausted: 'Diagnostics client: the sequence space is exhausted; relaunch the application.',
} as const;

/**
 * Parses and validates the endpoint: exactly `http://127.0.0.1:<port>`.
 *
 * @param endpoint - The endpoint string
 * @returns The numeric port
 * @throws {Error} With one fixed message for any other shape
 * @internal
 */
export function parseEndpoint(endpoint: string): number {
  // Exact-string match, not URL decomposition: a URL parser cannot tell
  // `http://127.0.0.1:4919` from `http://127.0.0.1:4919/` (both pathname
  // '/'), and the plan's rule is that the endpoint is EXACTLY this string
  // with no credentials, path, query, or fragment.
  const match = /^http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(endpoint);
  if (match === null) {
    throw new Error(CLIENT_ERRORS.endpoint);
  }
  const port = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(CLIENT_ERRORS.endpoint);
  }
  return port;
}

/**
 * Reads a response body under the hard byte ceiling, cancelling the stream
 * the moment it would overflow.
 *
 * @param response - The (already status-checked) response
 * @returns The exact body bytes
 * @throws {Error} The fixed connection-failure error on overflow or a null
 * body
 * @internal
 */
export async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    throw new Error(CLIENT_ERRORS.connection);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Cancel the source before refusing: an abandoned stream keeps the
        // connection's body open until GC otherwise.
        void reader.cancel().catch(() => {});
        throw new Error(CLIENT_ERRORS.connection);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Parses a verified response body, converting a malformed one into the fixed
 * connection error. A raw `JSON.parse` would throw a `SyntaxError` whose
 * message quotes the offending server bytes — the client's contract is that
 * no failure echoes peer input, and the pairing path already parsed this way.
 *
 * @param bodyText - The decoded, MAC-verified body
 * @returns The parsed value
 * @throws {Error} The fixed connection-failure error for a malformed body
 * @internal
 */
export function parseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error(CLIENT_ERRORS.connection);
  }
}

/**
 * Validates a paged read's cursor and limit — the ONE argument rule `read()`
 * and `queues()` share.
 *
 * @param after - The exclusive cursor
 * @param limit - The requested limit, or `undefined` for the default 128
 * @returns The effective limit
 * @throws {Error} The fixed argument error
 * @internal
 */
export function validatePagedArgs(after: number, limit: number | undefined): number {
  const effectiveLimit = limit ?? 128;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(effectiveLimit) ||
    effectiveLimit < 1 ||
    effectiveLimit > 128
  ) {
    throw new Error(CLIENT_ERRORS.arguments);
  }
  return effectiveLimit;
}

/**
 * Recursively freezes a freshly parsed value, so the documented "frozen" is
 * true of every nested record the client returns.
 *
 * @param value - The parsed value, owned by nobody else
 * @returns The same value, frozen
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
 * Creates the native diagnostics client.
 *
 * @param options - The injected client options
 * @returns The client
 * @throws {Error} At creation time for an invalid endpoint or credentials
 * @example
 * ```typescript
 * const client = createDiagnosticsClient({
 *   endpoint: 'http://127.0.0.1:4919',
 *   sessionId,
 *   sessionKey,
 *   subtle: crypto.subtle,
 *   fetch,
 *   timing: { setTimeout, clearTimeout },
 * });
 * const snapshot = await client.snapshot();
 * client.close();
 * ```
 * @since 0.8.0
 */
export function createDiagnosticsClient(options: DiagnosticsClientOptions): IDiagnosticsClient {
  const port = parseEndpoint(options.endpoint);
  if (!/^[0-9a-f]{32}$/.test(options.sessionId)) {
    throw new Error(CLIENT_ERRORS.sessionId);
  }
  if (!(options.sessionKey instanceof Uint8Array) || options.sessionKey.byteLength !== 32) {
    throw new Error(CLIENT_ERRORS.sessionKey);
  }

  let closed = false;
  let pairingFailed = false;
  let instanceId: string | null = null;
  // The authenticated inspector support manifest, cached from the pairing
  // exchange. `null` until paired. A legacy M98b server resolves this to the
  // all-false manifest, so `health()` answers `unsupported` without sending
  // an addon request.
  let inspectors: InspectorsManifest | null = null;
  let nextSequence = 1;
  let keyPromise: Promise<CryptoKey> | null = null;
  const inFlight = new Set<AbortController>();

  const getKey = (): Promise<CryptoKey> => {
    if (keyPromise === null) {
      keyPromise = importSessionKey(options.subtle, options.sessionKey);
    }
    return keyPromise;
  };

  // Serialization: each exchange runs only after the previous one settled,
  // so sequence numbers hit the wire strictly increasing.
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  const checkUsable = (): void => {
    if (closed) {
      throw new Error(CLIENT_ERRORS.closed);
    }
    if (pairingFailed) {
      throw new Error(CLIENT_ERRORS.pairingFailed);
    }
    if (nextSequence > Number.MAX_SAFE_INTEGER) {
      pairingFailed = true;
      throw new Error(CLIENT_ERRORS.exhausted);
    }
  };

  const exchange = async (target: string): Promise<{
    status: number;
    bodyBytes: Uint8Array;
    bodyText: string;
    responseInstance: string;
  }> => {
    checkUsable();
    const sequence = nextSequence;
    nextSequence += 1;
    const key = await getKey();
    const instance = instanceId ?? '';
    const requestFields = requestMacFields(
      options.sessionId,
      instance,
      String(sequence),
      `127.0.0.1:${port}`,
      target,
    );
    const mac = await signFields(options.subtle, key, requestFields);

    const controller = new AbortController();
    inFlight.add(controller);
    // The deadline and the abort handle govern the WHOLE exchange — headers
    // AND body. Clearing either at header time would let a stalled endpoint
    // hold the body read open indefinitely (the 256 KiB cap bounds volume,
    // not time) and would make close() unable to abort an in-flight read.
    const deadline = options.timing.setTimeout(
      () => controller.abort(),
      REQUEST_DEADLINE_MS,
    );
    try {
      let response: Response;
      try {
        response = await options.fetch(`http://127.0.0.1:${port}${target}`, {
          method: 'GET',
          headers: {
            'x-setu-session': options.sessionId,
            'x-setu-sequence': String(sequence),
            ...(instance === '' ? {} : { 'x-setu-instance': instance }),
            'x-setu-mac': mac,
          },
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch {
        throw new Error(CLIENT_ERRORS.connection);
      }
      if (response.status !== 200) {
        throw new Error(CLIENT_ERRORS.connection);
      }
      const bodyBytes = await readBoundedBody(response);
      // The deadline may fire between the last chunk and this line: an
      // exchange that overran its window fails closed.
      if (controller.signal.aborted) {
        throw new Error(CLIENT_ERRORS.connection);
      }
      const bodyHex = await sha256Hex(options.subtle, bodyBytes);
      const responseInstance = response.headers.get('x-setu-instance') ?? '';
      const responseMac = response.headers.get('x-setu-mac') ?? '';
      const responseFields = responseMacFields(
        options.sessionId,
        responseInstance,
        String(sequence),
        target,
        String(response.status),
        bodyHex,
      );
      const verified = parseMac(responseMac) !== null &&
        await verifyFields(options.subtle, key, responseMac, responseFields);
      if (!verified) {
        throw new Error(CLIENT_ERRORS.connection);
      }
      // Paired-instance binding, at the ONE boundary every operation shares.
      // The MAC proves the peer holds the session key; it does not prove the
      // peer answered as the instance this session paired with, because the
      // header identity is an input to the MAC rather than a constant of it.
      // Once paired, the request presented `instance`, and a signed response
      // naming any other identity is refused. The unpaired status exchange
      // presents '' and is bound against its own body in `exchangeAndBind`.
      if (instance !== '' && responseInstance !== instance) {
        throw new Error(CLIENT_ERRORS.connection);
      }
      return {
        status: response.status,
        bodyBytes,
        bodyText: new TextDecoder().decode(bodyBytes),
        responseInstance,
      };
    } catch {
      // One fixed failure for the whole exchange: network, non-200, bounds,
      // deadline, abort (including close() during the read), verification.
      throw new Error(CLIENT_ERRORS.connection);
    } finally {
      options.timing.clearTimeout(deadline);
      inFlight.delete(controller);
    }
  };

  const exchangeAndBind = async (target: string): Promise<void> => {
    let result;
    try {
      result = await exchange(target);
    } catch (error) {
      // ANY failure of the initial pairing exchange is terminal: discard
      // the session and relaunch rather than accepting another server
      // under the same identity.
      pairingFailed = true;
      throw error;
    }
    // The status body is parsed only AFTER its MAC verified, and the parsed
    // instance must agree with the authenticated header. Both the legacy
    // M98b three-field body and the new four-field body (with the inspector
    // manifest) are accepted; the legacy body resolves to the all-false
    // manifest.
    let parsed: unknown;
    try {
      parsed = parseBody(result.bodyText);
    } catch (error) {
      pairingFailed = true;
      throw error;
    }
    const status = parseStatusBody(parsed);
    if (status === null || status.instanceId !== result.responseInstance) {
      pairingFailed = true;
      throw new Error(CLIENT_ERRORS.connection);
    }
    instanceId = status.instanceId;
    inspectors = status.inspectors;
  };

  return {
    async snapshot(): Promise<DiagnosticsSnapshot> {
      return await enqueue(async () => {
        checkUsable();
        if (instanceId === null) {
          await exchangeAndBind(STATUS_TARGET);
          checkUsable();
        }
        const result = await exchange(SNAPSHOT_TARGET);
        const parsed = parseBody(result.bodyText);
        // The body's own identity must be the paired one. The DTO type admits
        // `null` for an in-process reader before the runtime assigns an
        // identity; a paired network session always has one, so `null` (and
        // an absent field, which the validator already refuses) is refused.
        if (!isSnapshotProjection(parsed) || parsed.instanceId !== instanceId) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        // The parsed value is a fresh object graph owned by nobody else;
        // deep-freezing it (nodes and edges too) is what makes the documented
        // "frozen" true, as the addon paths already do.
        return deepFreeze(parsed);
      });
    },

    async read(after: number, limit?: number): Promise<DiagnosticsBatch> {
      return await enqueue(async () => {
        checkUsable();
        const effectiveLimit = validatePagedArgs(after, limit);
        if (instanceId === null) {
          await exchangeAndBind(STATUS_TARGET);
          checkUsable();
        }
        const target = `/v1/events?after=${after}&limit=${effectiveLimit}`;
        const result = await exchange(target);
        const parsed = parseBody(result.bodyText);
        // The same body binding as `snapshot()`: a paired batch carries the
        // paired identity, never `null` and never another instance's. Then the
        // cursor contract relative to THIS request, as `queues()` and
        // `traces()` check it: an empty page echoes the cursor, and a returned
        // page starts past it with `lost` counting exactly the gap.
        if (
          !isBatchProjection(parsed) || parsed.instanceId !== instanceId ||
          parsed.events.length > effectiveLimit ||
          (parsed.events.length === 0 ? parsed.next !== after || parsed.lost !== 0 : (
            parsed.events[0].sequence <= after ||
            parsed.lost !== parsed.events[0].sequence - after - 1
          ))
        ) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        return deepFreeze(parsed);
      });
    },

    async health(): Promise<HealthDiagnosticsSnapshot> {
      return await enqueue(async () => {
        checkUsable();
        if (instanceId === null) {
          await exchangeAndBind(STATUS_TARGET);
          checkUsable();
        }
        // exchangeAndBind sets the instance or throws; capture it locally so
        // the typed unsupported DTO below is built from a non-null UUID.
        const bound = instanceId;
        if (bound === null) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        // Negotiated support: when the authenticated manifest reports the
        // health inspector as unsupported, return a frozen typed `unsupported`
        // DTO WITHOUT sending an addon request. This is the release-skew path
        // — a legacy server advertised no inspectors — and it never probes an
        // unknown route or infers support from a generic protocol error.
        if (inspectors !== null && inspectors.health === false) {
          return Object.freeze({
            version: 1,
            instanceId: bound,
            state: 'unsupported',
            observations: Object.freeze([]),
            truncated: false,
            droppedObservations: 0,
          });
        }
        const result = await exchange(HEALTH_TARGET);
        const parsed = parseBody(result.bodyText);
        // The exact DTO validator, plus the body's own instance binding: the
        // signed body must describe the instance this session paired with.
        if (!isHealthSnapshotProjection(parsed) || parsed.instanceId !== bound) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        // The parsed value is a fresh object graph owned by nobody else;
        // freezing it is what makes the documented "frozen" true.
        for (const observation of parsed.observations) {
          Object.freeze(observation);
        }
        Object.freeze(parsed.observations);
        return Object.freeze(parsed);
      });
    },

    async configuration(): Promise<ConfigDiagnosticsSnapshot> {
      return await enqueue(async () => {
        checkUsable();
        if (instanceId === null) {
          await exchangeAndBind(STATUS_TARGET);
          checkUsable();
        }
        // exchangeAndBind sets the instance or throws; capture it locally so
        // the typed unsupported DTO below is built from a non-null UUID.
        const bound = instanceId;
        if (bound === null) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        // Negotiated support: when the authenticated manifest reports the
        // configuration inspector as unsupported, return a frozen typed
        // `unsupported` DTO WITHOUT sending an addon request. This is the
        // release-skew path — a legacy server advertised no inspectors — and
        // it never probes an unknown route or infers support from a generic
        // protocol error.
        if (inspectors !== null && inspectors.configuration === false) {
          return Object.freeze({
            version: 1,
            instanceId: bound,
            state: 'unsupported',
            entries: Object.freeze([]),
            truncated: false,
            droppedEntries: 0,
          });
        }
        const result = await exchange(CONFIG_TARGET);
        const parsed = parseBody(result.bodyText);
        // The exact DTO validator, plus the body's own instance binding: the
        // signed body must describe the instance this session paired with.
        if (!isConfigSnapshotProjection(parsed) || parsed.instanceId !== bound) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        // The parsed value is a fresh object graph owned by nobody else;
        // deep-freezing it (entries AND their alias arrays) is what makes the
        // documented "deeply frozen" true.
        return deepFreeze(parsed);
      });
    },

    async queues(after: number, limit?: number): Promise<QueueDiagnosticsBatch> {
      return await enqueue(async () => {
        checkUsable();
        const effectiveLimit = validatePagedArgs(after, limit);
        if (instanceId === null) {
          await exchangeAndBind(STATUS_TARGET);
          checkUsable();
        }
        const bound = instanceId;
        if (bound === null) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        // Negotiated support: a manifest without the queue inspector — a
        // legacy or older server — is answered locally with a frozen typed
        // `unsupported` batch echoing the cursor, and no addon request is
        // sent. Support is never inferred from a generic protocol error.
        if (inspectors !== null && inspectors.queues === false) {
          return deepFreeze({
            version: 1,
            instanceId: bound,
            state: 'unsupported',
            sources: [],
            events: [],
            depths: [],
            next: after,
            lost: 0,
            truncatedSources: 0,
            truncatedDepths: 0,
          });
        }
        const result = await exchange(`${QUEUES_PATH}?after=${after}&limit=${effectiveLimit}`);
        const parsed = parseBody(result.bodyText);
        // The exact DTO validator, the body's own instance binding, and the
        // cursor contract relative to THIS request: an empty page echoes the
        // cursor, and a returned page starts past it.
        if (
          !isQueueBatchProjection(parsed) || parsed.instanceId !== bound ||
          parsed.events.length > effectiveLimit ||
          (parsed.events.length === 0 ? parsed.next !== after || parsed.lost !== 0 : (
            parsed.events[0].sequence <= after ||
            parsed.lost !== parsed.events[0].sequence - after - 1
          ))
        ) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        return deepFreeze(parsed);
      });
    },

    async traces(after: number, limit?: number): Promise<TraceDiagnosticsBatch> {
      return await enqueue(async () => {
        checkUsable();
        const effectiveLimit = validatePagedArgs(after, limit);
        if (instanceId === null) {
          await exchangeAndBind(STATUS_TARGET);
          checkUsable();
        }
        const bound = instanceId;
        if (bound === null) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        // Negotiated support: a manifest without the trace inspector — a
        // legacy or older server — is answered locally with a frozen typed
        // `unsupported` batch echoing the cursor, and no addon request is
        // sent. Support is never inferred from a generic protocol error.
        if (inspectors !== null && inspectors.traces === false) {
          return deepFreeze({
            version: 1,
            instanceId: bound,
            state: 'unsupported',
            coverage: 'unknown',
            instrumentation: [],
            sampler: { kind: 'unknown' },
            records: [],
            next: after,
            lost: 0,
            closed: false,
            droppedSpans: 0,
          });
        }
        const result = await exchange(`${TRACES_PATH}?after=${after}&limit=${effectiveLimit}`);
        const parsed = parseBody(result.bodyText);
        // The exact DTO validator, the body's own instance binding, and the
        // cursor contract relative to THIS request: an empty page echoes the
        // cursor, and a returned page starts past it.
        if (
          !isTraceBatchProjection(parsed) || parsed.instanceId !== bound ||
          parsed.records.length > effectiveLimit ||
          (parsed.records.length === 0 ? parsed.next !== after || parsed.lost !== 0 : (
            parsed.records[0].sequence <= after ||
            parsed.lost !== parsed.records[0].sequence - after - 1
          ))
        ) {
          throw new Error(CLIENT_ERRORS.connection);
        }
        return deepFreeze(parsed);
      });
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      for (const controller of inFlight) {
        controller.abort();
      }
      inFlight.clear();
      // Drop the key reference; the raw bytes were already zeroed by the
      // import. Nothing is promised about garbage-collected memory.
      keyPromise = null;
    },
  };
}
