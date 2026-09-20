/**
 * The connector's protocol handler — the callback the runtime-owned
 * listener serves.
 *
 * Dispatch only: this module owns NO socket, NO adapter, and NO server
 * handle. It receives the normalized framework request the listener mapped,
 * validates the protocol, authenticates the session, reads M98a's
 * diagnostics through the pull-only facade, and returns a signed framework
 * response. Every refusal is a fixed, value-free body; no supplied header
 * is ever logged or echoed.
 *
 * @module
 */

import type {
  HandlerResult,
  IDiagnosticsSource,
  IRequest,
  IResponse,
  ResponseSnapshot,
} from '@setu-ts/common';

import { requestMacFields, responseMacFields, sha256Hex } from '../security/authentication.ts';
import type { DiagnosticsSessionState } from '../security/session.ts';
import type { ConnectorLimits, LimitsClock } from './limits.ts';
import { CONNECTOR_LIMITS } from './limits.ts';
import {
  errorBody,
  parseTarget,
  projectBatch,
  projectSnapshot,
  PROTOCOL_ERRORS,
  PROTOCOL_RESPONSE_HEADERS,
  type ProtocolErrorCode,
  statusBody,
} from '../protocol/protocol.ts';

/**
 * The `Host`/authority value the protocol requires:
 * exactly `127.0.0.1:<port>`.
 *
 * @internal
 */
export function loopbackAuthority(port: number): string {
  return `127.0.0.1:${port}`;
}

const ENCODER = new TextEncoder();

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
const SEQUENCE_PATTERN = /^[1-9][0-9]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_HEADER_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The `HandlerResult` brand value for this module's internal response
 * builder (only the kernel creates real ones; this is a plain conforming
 * object).
 *
 * @internal
 */
const HANDLER_RESULT: HandlerResult = { __handlerResult: true };

/**
 * Minimal internal {@linkcode IResponse} builder. Only status, header,
 * JSON/send, and snapshot are meaningful for this protocol; the remaining
 * interface methods exist to satisfy the contract and throw a documented
 * fixed error — this transport serves pre-serialized bytes, not framework
 * response features.
 *
 * @internal
 */
class ProtocolResponse implements IResponse {
  #status = 200;
  readonly #headers = new Headers(PROTOCOL_RESPONSE_HEADERS);
  #body: Uint8Array | string | null = null;

  status(code: number): IResponse {
    this.#status = code;
    return this;
  }

  header(name: string, value: string): IResponse {
    this.#headers.set(name, value);
    return this;
  }

  appendHeader(name: string, value: string): IResponse {
    this.#headers.append(name, value);
    return this;
  }

  json<T>(body: T): HandlerResult {
    this.#body = ENCODER.encode(JSON.stringify(body));
    return HANDLER_RESULT;
  }

  text(body: string): HandlerResult {
    this.#body = ENCODER.encode(body);
    return HANDLER_RESULT;
  }

  html(_body: string): HandlerResult {
    throw new Error('The diagnostics protocol response does not support HTML bodies.');
  }

  send(body?: Uint8Array): HandlerResult {
    this.#body = body ?? new Uint8Array(0);
    return HANDLER_RESULT;
  }

  redirect(_url: string, _status?: number): HandlerResult {
    throw new Error('The diagnostics protocol response does not support redirects.');
  }

  stream(_body: ReadableStream<Uint8Array>): HandlerResult {
    throw new Error('The diagnostics protocol response does not support streaming bodies.');
  }

  snapshot(): ResponseSnapshot {
    return {
      streaming: false,
      status: this.#status,
      headers: this.#headers,
      body: this.#body,
    };
  }
}

/**
 * Dependencies of the protocol handler, all injected.
 *
 * @internal
 */
export interface ConnectorHandlerDeps {
  /** The bound loopback port; part of the authenticated authority. */
  readonly port: number;
  /** The Web Crypto SubtleCrypto used for the body digest. */
  readonly subtle: SubtleCrypto;
  /** The single paired session. */
  readonly session: DiagnosticsSessionState;
  /** Rate and concurrency admission. */
  readonly limits: ConnectorLimits;
  /** M98a's pull-only diagnostics facade on the owning application. */
  readonly source: IDiagnosticsSource;
  /** The monotonic clock. */
  readonly clock: LimitsClock;
}

/**
 * Builds one fixed, value-free refusal response.
 *
 * @param code - One fixed protocol error code
 * @returns The refusal as a framework response
 * @internal
 */
export function refusalResponse(code: ProtocolErrorCode): IResponse {
  const response = new ProtocolResponse();
  response.status(PROTOCOL_ERRORS[code]).json(errorBody(code));
  return response;
}

/**
 * Answers a raw-validation failure: the anonymous refusal budget pays for
 * the specific error when it has capacity, and once exhausted the refusal
 * becomes `rate-limited` — a flood of malformed requests cannot even buy
 * unlimited fixed-error responses.
 *
 * @param limits - The connector limits
 * @param code - The structural error that was detected
 * @returns The refusal to serve
 * @internal
 */
function rawRefusal(limits: ConnectorLimits, code: ProtocolErrorCode): IResponse {
  return refusalResponse(limits.admitRawRefusal() ? code : 'rate-limited');
}

/**
 * Validates the semantic header grammar AFTER framework mapping — defence
 * in depth beside the listener's native pre-mapping checks. Returns the
 * parsed header fields, or `null` when any grammar is violated.
 *
 * @param request - The mapped framework request
 * @returns The parsed fields, or `null`
 * @internal
 */
export function validateProtocolHeaders(request: IRequest): {
  sessionId: string;
  sequence: number;
  instance: string | null;
  mac: string;
} | null {
  const headers = request.headers;
  const sessionId = headers.get('x-setu-session') ?? '';
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  const sequenceRaw = headers.get('x-setu-sequence') ?? '';
  if (!SEQUENCE_PATTERN.test(sequenceRaw) || sequenceRaw.length > 16) {
    return null;
  }
  const sequence = Number.parseInt(sequenceRaw, 10);
  if (!Number.isSafeInteger(sequence)) {
    return null;
  }
  const instanceRaw = headers.get('x-setu-instance');
  if (
    instanceRaw !== null &&
    instanceRaw !== '' &&
    !UUID_PATTERN.test(instanceRaw)
  ) {
    return null;
  }
  const mac = headers.get('x-setu-mac') ?? '';
  if (!MAC_HEADER_PATTERN.test(mac)) {
    return null;
  }
  return { sessionId, sequence, instance: instanceRaw, mac };
}

/**
 * Creates the protocol handler the connector hands to the runtime-owned
 * listener factory.
 *
 * @param deps - The handler's injected dependencies
 * @returns The handler: normalized request in, signed framework response out
 * @internal
 */
export function createConnectorHandler(
  deps: ConnectorHandlerDeps,
): (request: IRequest) => Promise<IResponse> {
  const authority = loopbackAuthority(deps.port);
  return async (request: IRequest): Promise<IResponse> => {
    // Method first: anything but GET is a raw-validation refusal paid from
    // the anonymous budget — it never enters the handler slots.
    if (request.method !== 'GET') {
      return rawRefusal(deps.limits, 'invalid-request');
    }
    // The admission-time pairing check: comparing the session-ID header
    // against the paired session's ID decides which concurrency lane the
    // request competes in. It is not authentication — the MAC below is —
    // but it is what keeps an unpaired flood out of the reserved slot.
    const paired = (request.headers.get('x-setu-session') ?? '') === deps.session.sessionId;
    if (!deps.limits.beginHandler(paired)) {
      return refusalResponse('rate-limited');
    }
    let inVerify = false;
    let promoted = false;
    try {
      // --- Structural checks (no crypto, no diagnostic reads) -------------
      const headers = request.headers;
      if (headers.get('host') !== authority) {
        return rawRefusal(deps.limits, 'invalid-request');
      }
      // ANY Origin — including `null` — means a browser context. This
      // endpoint is native-clients-only; preflights receive the same refusal
      // and no CORS permission is ever emitted.
      if (headers.has('origin')) {
        return rawRefusal(deps.limits, 'invalid-request');
      }
      const parsed = validateProtocolHeaders(request);
      if (parsed === null) {
        return rawRefusal(deps.limits, 'invalid-request');
      }
      if (!deps.limits.headersWithinBudget(headers)) {
        return rawRefusal(deps.limits, 'invalid-request');
      }
      const url = new URL(request.url);
      if (url.host !== authority) {
        return rawRefusal(deps.limits, 'invalid-request');
      }
      const target = parseTarget(url.pathname, url.search.slice(1));
      if (target === null) {
        return rawRefusal(deps.limits, 'invalid-request');
      }
      if (parsed.sessionId !== deps.session.sessionId) {
        return rawRefusal(deps.limits, 'unauthorized');
      }
      // Non-status requests must SUPPLY the bound instance (structural);
      // whether it is the RIGHT one is authentication, checked below.
      if (target.op !== 'status' && parsed.instance === null) {
        return rawRefusal(deps.limits, 'invalid-request');
      }
      if (!deps.limits.beginVerify()) {
        return refusalResponse('rate-limited');
      }
      inVerify = true;

      // --- Authentication --------------------------------------------------
      const requestFields = requestMacFields(
        parsed.sessionId,
        target.op === 'status' ? (parsed.instance ?? '') : (parsed.instance as string),
        String(parsed.sequence),
        authority,
        target.canonicalTarget,
      );
      if (!(await deps.session.verify(requestFields, parsed.mac))) {
        return refusalResponse('unauthorized');
      }
      // --- The atomic post-verification gate -------------------------------
      if (!deps.session.admitAfterVerify(parsed.sequence, deps.clock)) {
        return refusalResponse(
          deps.session.remainingMs(deps.clock) === 0 ? 'expired' : 'unauthorized',
        );
      }
      if (!deps.limits.promote(parsed.sessionId)) {
        return refusalResponse('rate-limited');
      }
      promoted = true;

      // Cross-instance check for every non-status operation: the presented
      // instance UUID must be THIS session's bound instance. (Status binds
      // and compares inside its own branch below.)
      if (target.op !== 'status' && parsed.instance !== deps.session.instanceId) {
        return refusalResponse('unauthorized');
      }

      // --- Read and project, binding the instance on the first status ------
      let projected: Record<string, unknown>;
      if (target.op === 'status') {
        const snapshot = deps.source.snapshot();
        if (snapshot.instanceId === null) {
          return refusalResponse('unavailable');
        }
        const presented = parsed.instance ?? '';
        // A presented UUID must be THIS application's instance; an empty
        // instance is accepted only on the FIRST status exchange. Obtaining
        // a UUID alone grants nothing — the session key is still required —
        // but a wrong or stale UUID must not mix sessions across instances.
        if (presented !== '' && presented !== snapshot.instanceId) {
          return refusalResponse('unauthorized');
        }
        if (presented === '' && deps.session.hasInstance()) {
          return refusalResponse('unauthorized');
        }
        deps.session.bindInstance(snapshot.instanceId);
        projected = statusBody(
          snapshot.instanceId,
          deps.session.remainingMs(deps.clock),
        );
      } else if (target.op === 'snapshot') {
        const snapshot = deps.source.snapshot();
        if (snapshot.version !== 1) {
          return refusalResponse('unsupported-version');
        }
        if (snapshot.instanceId !== deps.session.instanceId) {
          return refusalResponse('unauthorized');
        }
        projected = projectSnapshot(snapshot);
      } else {
        const batch = deps.source.read(target.after, target.limit);
        if (batch.version !== 1) {
          return refusalResponse('unsupported-version');
        }
        if (batch.instanceId !== deps.session.instanceId) {
          return refusalResponse('unauthorized');
        }
        projected = projectBatch(batch);
      }

      // --- Serialize, bound, re-check, sign --------------------------------
      const bodyBytes = ENCODER.encode(JSON.stringify(projected));
      if (bodyBytes.byteLength > CONNECTOR_LIMITS.maxResponseBytes) {
        return refusalResponse('unavailable');
      }
      // Post-await response gate: a revocation during any await above
      // discards the built data rather than releasing it.
      if (!deps.session.isAdmissible(deps.clock)) {
        return refusalResponse('expired');
      }
      const instanceId = deps.session.instanceId;
      if (instanceId === null) {
        return refusalResponse('unavailable');
      }
      const bodyHex = await sha256Hex(deps.subtle, bodyBytes);
      const responseFields = responseMacFields(
        parsed.sessionId,
        instanceId,
        String(parsed.sequence),
        target.canonicalTarget,
        '200',
        bodyHex,
      );
      const mac = await deps.session.sign(responseFields);
      if (mac === null || !deps.session.isAdmissible(deps.clock)) {
        return refusalResponse('expired');
      }
      const response = new ProtocolResponse();
      response.status(200).json(projected);
      response.header('x-setu-mac', mac);
      response.header('x-setu-instance', instanceId);
      return response;
    } finally {
      if (inVerify && !promoted) {
        deps.limits.endVerify();
      }
      deps.limits.release(paired);
    }
  };
}
