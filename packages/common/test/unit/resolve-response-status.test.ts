/**
 * Tests for the serveable-status guard on the error responder seam.
 *
 * The web `Response` constructor throws `RangeError` outside `[200, 599]` and
 * for a non-integer, so an application-authored status — `FlagGuardOptions
 * .statusCode`, the multi-tenancy `rejectionStatus`, a `WebSocketGuardDecision
 * .status` — could make the error path itself the fault. `4004` is the case
 * that matters: a plausible typo for `404`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HandlerResult, IResponse } from '../../src/http.ts';
import type { IServiceRegistry } from '../../src/registry.ts';
import { CAPABILITIES } from '../../src/tokens.ts';
import {
  ERROR_RESPONDER_STATE_KEY,
  type ErrorResponderTarget,
  type ErrorResponseInit,
  resolveResponseStatus,
  respondWithError,
} from '../../src/errors/error-responder.ts';

/** A response builder recording the status and body it was handed. */
function makeResponse() {
  const recorded = { status: 0, body: undefined as Uint8Array | undefined };
  const response: IResponse = {
    status(code: number) {
      recorded.status = code;
      return response;
    },
    header: () => response,
    appendHeader: () => response,
    json(body: unknown) {
      recorded.body = new TextEncoder().encode(JSON.stringify(body));
      return {} as HandlerResult;
    },
    text: () => ({}) as HandlerResult,
    html: () => ({}) as HandlerResult,
    send(body?: Uint8Array) {
      recorded.body = body;
      return {} as HandlerResult;
    },
    redirect: () => ({}) as HandlerResult,
    stream: () => ({}) as HandlerResult,
    snapshot: () => ({
      streaming: false as const,
      status: recorded.status,
      headers: new Headers(),
      body: null,
    }),
  };
  return { response, recorded };
}

/** Records what the logger capability was told. */
function makeLoggerServices(options: { throws?: boolean; registered?: boolean } = {}) {
  const calls: Array<{ message: string; meta: unknown }> = [];
  const logger = {
    error(message: string, meta: unknown) {
      if (options.throws) throw new Error('logger transport is down');
      calls.push({ message, meta });
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  };
  const services = {
    has: (token: string) => options.registered !== false && token === CAPABILITIES.LOGGER,
    get: <T>() => logger as T,
  } as unknown as IServiceRegistry;
  return { services, calls };
}

/** A target, optionally carrying `services` (a full request context does). */
function makeTarget(services?: IServiceRegistry) {
  const state = new Map<string, unknown>();
  const { response, recorded } = makeResponse();
  const base: ErrorResponderTarget = { state, response, request: { path: '/x' } };
  const t = services === undefined ? base : { ...base, services };
  return { t: t as ErrorResponderTarget, state, recorded };
}

describe('resolveResponseStatus', () => {
  it('passes a serveable status through unchanged, including both bounds', () => {
    const { t } = makeTarget();
    for (const status of [200, 302, 404, 500, 599]) {
      expect(resolveResponseStatus(status, t)).toBe(status);
    }
  });

  it('clamps a status outside [200, 599] to 500', () => {
    const { t } = makeTarget();
    // 4004 is the recorded real-world case: a typo for 404.
    for (const status of [4004, 999, 600, 199, 100, 0, -1]) {
      expect(resolveResponseStatus(status, t)).toBe(500);
    }
  });

  it('clamps a non-integer to 500 — NaN satisfies neither < nor >, so the integer check must come first', () => {
    const { t } = makeTarget();
    for (const status of [Number.NaN, 200.5, 404.1, Number.POSITIVE_INFINITY, -Infinity]) {
      expect(resolveResponseStatus(status, t)).toBe(500);
    }
  });

  it('reports the clamp through the logger capability when one is reachable', () => {
    const { services, calls } = makeLoggerServices();
    const { t } = makeTarget(services);
    resolveResponseStatus(4004, t);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('unserveable status');
    expect(calls[0].meta).toEqual({ status: 4004, clampedTo: 500 });
  });

  it('reports nothing for a serveable status', () => {
    const { services, calls } = makeLoggerServices();
    const { t } = makeTarget(services);
    resolveResponseStatus(404, t);
    expect(calls).toHaveLength(0);
  });

  it('clamps silently when the target carries no services (the pre-pipeline sites)', () => {
    const { t } = makeTarget();
    expect(resolveResponseStatus(4004, t)).toBe(500);
  });

  it('clamps silently when no logger capability is registered', () => {
    const { services, calls } = makeLoggerServices({ registered: false });
    const { t } = makeTarget(services);
    expect(resolveResponseStatus(4004, t)).toBe(500);
    expect(calls).toHaveLength(0);
  });

  it('still clamps when the logger itself throws — reporting must never replace the response', () => {
    const { services } = makeLoggerServices({ throws: true });
    const { t } = makeTarget(services);
    expect(resolveResponseStatus(4004, t)).toBe(500);
  });
});

describe('respondWithError with an unserveable status', () => {
  it('writes 500 on the no-responder fallback path', () => {
    const { t, recorded } = makeTarget();
    respondWithError(t, { status: 4004, title: 'Not Found' });
    expect(recorded.status).toBe(500);
    expect(new TextDecoder().decode(recorded.body!)).toBe('{"error":"Not Found"}');
  });

  it('hands a responder a SANITIZED init, so its formatted body agrees with the written status', () => {
    const seen: ErrorResponseInit[] = [];
    const { t, state } = makeTarget();
    state.set(ERROR_RESPONDER_STATE_KEY, {
      respond(_t: ErrorResponderTarget, init: ErrorResponseInit) {
        seen.push(init);
      },
    });
    respondWithError(t, { status: 4004, title: 'Not Found', detail: 'gone' });
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe(500);
    // Every other member survives verbatim.
    expect(seen[0].title).toBe('Not Found');
    expect(seen[0].detail).toBe('gone');
  });

  it('reuses the original init object when the status is already serveable', () => {
    const seen: ErrorResponseInit[] = [];
    const { t, state } = makeTarget();
    state.set(ERROR_RESPONDER_STATE_KEY, {
      respond(_t: ErrorResponderTarget, init: ErrorResponseInit) {
        seen.push(init);
      },
    });
    const init: ErrorResponseInit = { status: 404, title: 'Not Found' };
    respondWithError(t, init);
    expect(seen[0]).toBe(init);
  });

  it('reports the clamp exactly once, not once per guard, on the responder path', () => {
    const { services, calls } = makeLoggerServices();
    const { t, state } = makeTarget(services);
    state.set(ERROR_RESPONDER_STATE_KEY, {
      respond(target: ErrorResponderTarget, init: ErrorResponseInit) {
        // The responder's own guard re-runs, as `createErrorResponder` does.
        resolveResponseStatus(init.status, target);
      },
    });
    respondWithError(t, { status: 4004, title: 'Not Found' });
    expect(calls).toHaveLength(1);
  });
});
