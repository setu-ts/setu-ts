/**
 * Tests for the request-scoped error responder seam (M70f).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HandlerResult, IResponse } from '../../src/http.ts';
import {
  ERROR_RESPONDER_STATE_KEY,
  type ErrorResponderTarget,
  type ErrorResponseInit,
  respondWithError,
} from '../../src/errors/error-responder.ts';

/** A minimal response builder that records the terminal call. */
function makeResponse() {
  const recorded = {
    status: 0,
    contentType: '' as string,
    body: undefined as Uint8Array | undefined,
  };
  const response: IResponse = {
    status(code: number) {
      recorded.status = code;
      return response;
    },
    header(name: string, value: string) {
      if (name === 'content-type') {
        recorded.contentType = value;
      }
      return response;
    },
    appendHeader() {
      return response;
    },
    json(body: unknown) {
      // Mirrors ResponseBuilder.json(): sets the content-type itself.
      recorded.body = new TextEncoder().encode(JSON.stringify(body));
      recorded.contentType = 'application/json; charset=utf-8';
      return {} as HandlerResult;
    },
    text(body: string) {
      recorded.body = new TextEncoder().encode(body);
      return {} as HandlerResult;
    },
    html(body: string) {
      recorded.body = new TextEncoder().encode(body);
      // Mirrors the kernel builder, which sets this header — a double that
      // omitted it could pass a test the real builder would fail.
      recorded.contentType = 'text/html; charset=utf-8';
      return {} as HandlerResult;
    },
    send(body?: Uint8Array) {
      recorded.body = body;
      return {} as HandlerResult;
    },
    redirect() {
      return {} as HandlerResult;
    },
    stream() {
      return {} as HandlerResult;
    },
    snapshot() {
      return { streaming: false, status: recorded.status, headers: new Headers(), body: null };
    },
  };
  return { response, recorded };
}

/** Builds a target over a fresh state map. */
function target(responder?: unknown): { t: ErrorResponderTarget; state: Map<string, unknown> } {
  const state = new Map<string, unknown>();
  if (responder !== undefined) {
    state.set(ERROR_RESPONDER_STATE_KEY, responder);
  }
  const { response } = makeResponse();
  const t: ErrorResponderTarget = { state, response, request: { path: '/x' } };
  return { t, state };
}

describe('respondWithError', () => {
  it('writes the framework-default { error, detail? } body when no responder is present', () => {
    const { t, state } = target();
    const { response, recorded } = makeResponse();
    const target2: ErrorResponderTarget = { state, response, request: { path: '/x' } };
    respondWithError(target2, { status: 404, title: 'Not Found' });
    expect(recorded.status).toBe(404);
    expect(recorded.contentType).toBe('application/json; charset=utf-8');
    expect(new TextDecoder().decode(recorded.body!)).toBe('{"error":"Not Found"}');
    void t;
  });

  it('includes detail when the init carries one', () => {
    const { state } = target();
    const { response, recorded } = makeResponse();
    const target2: ErrorResponderTarget = { state, response, request: { path: '/x' } };
    respondWithError(target2, { status: 400, title: 'Bad Request', detail: 'nope' });
    expect(new TextDecoder().decode(recorded.body!)).toBe(
      '{"error":"Bad Request","detail":"nope"}',
    );
  });

  it('delegates to a conforming responder published under the key', () => {
    let called = 0;
    let gotInit: ErrorResponseInit | undefined;
    const responder = {
      respond(_t: ErrorResponderTarget, init: ErrorResponseInit) {
        called++;
        gotInit = init;
      },
    };
    const { state } = target(responder);
    const { response } = makeResponse();
    const target2: ErrorResponderTarget = { state, response, request: { path: '/x' } };
    respondWithError(target2, { status: 403, title: 'Forbidden' });
    expect(called).toBe(1);
    expect(gotInit).toEqual({ status: 403, title: 'Forbidden' });
  });

  it('ignores a non-conforming state value rather than throwing', () => {
    // A string under the key is not a responder — the fallback must be written.
    const { state } = target('not-a-responder');
    const { response, recorded } = makeResponse();
    const target2: ErrorResponderTarget = { state, response, request: { path: '/x' } };
    expect(() => respondWithError(target2, { status: 500, title: 'ISE' })).not.toThrow();
    expect(new TextDecoder().decode(recorded.body!)).toBe('{"error":"ISE"}');
  });

  it('ignores a null state value rather than throwing', () => {
    const { state } = target(null);
    const { response, recorded } = makeResponse();
    const target2: ErrorResponderTarget = { state, response, request: { path: '/x' } };
    expect(() => respondWithError(target2, { status: 500, title: 'ISE' })).not.toThrow();
    expect(new TextDecoder().decode(recorded.body!)).toBe('{"error":"ISE"}');
  });

  it('exposes a stable string state key', () => {
    expect(typeof ERROR_RESPONDER_STATE_KEY).toBe('string');
    expect(ERROR_RESPONDER_STATE_KEY.length).toBeGreaterThan(0);
  });
});
