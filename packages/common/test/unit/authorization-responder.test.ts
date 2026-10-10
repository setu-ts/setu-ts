/**
 * Tests for the authorization refusal responder and its single owner of the
 * refusal values (M110a §3.9).
 *
 * The four arms are pinned against LITERALS, as data: a responder that kept
 * its old inline strings while the helper drifted — or the reverse — fails a
 * row here rather than passing because both sides read one constant.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HandlerResult, IResponse } from '../../src/http.ts';
import {
  type AuthorizationFailure,
  authorizationFailureInit,
  respondWithAuthorizationFailure,
} from '../../src/errors/authorization-responder.ts';
import {
  ERROR_RESPONDER_STATE_KEY,
  type ErrorResponderTarget,
  type ErrorResponseInit,
} from '../../src/errors/error-responder.ts';

const EXPECTED: readonly {
  readonly failure: AuthorizationFailure;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
}[] = [
  {
    failure: 'authentication-required',
    status: 401,
    title: 'Unauthorized',
    detail: 'Authentication required',
  },
  {
    failure: 'not-configured',
    status: 501,
    title: 'Not Implemented',
    detail: 'Authorization is not configured',
  },
  {
    failure: 'insufficient-privileges',
    status: 403,
    title: 'Forbidden',
    detail: 'Insufficient privileges',
  },
  {
    failure: 'second-factor-required',
    status: 403,
    title: 'Forbidden',
    detail: 'Second factor required',
  },
];

/** Records the status and JSON body the no-responder fallback writes. */
function recordingTarget(state: Map<string, unknown> = new Map()): {
  readonly target: ErrorResponderTarget;
  readonly recorded: { status: number; body: unknown };
} {
  const recorded = { status: 0, body: undefined as unknown };
  const response = {
    status(code: number) {
      recorded.status = code;
      return response;
    },
    json(body: unknown) {
      recorded.body = body;
      return {} as HandlerResult;
    },
  } as unknown as IResponse;
  return { target: { state, response, request: { path: '/x' } }, recorded };
}

describe('authorizationFailureInit', () => {
  for (const row of EXPECTED) {
    it(`returns ${row.status} ${row.title} / "${row.detail}" for ${row.failure}`, () => {
      expect(authorizationFailureInit(row.failure)).toEqual({
        status: row.status,
        title: row.title,
        detail: row.detail,
      });
    });
  }

  it('hands out a frozen value, so no caller can change a later refusal', () => {
    const init = authorizationFailureInit('insufficient-privileges');
    expect(Object.isFrozen(init)).toBe(true);
    expect(() => {
      (init as { detail: string }).detail = 'You need the "admin" role';
    }).toThrow(TypeError);
    expect(authorizationFailureInit('insufficient-privileges').detail).toBe(
      'Insufficient privileges',
    );
  });
});

describe('respondWithAuthorizationFailure', () => {
  for (const row of EXPECTED) {
    it(`writes ${row.status} with the fallback body for ${row.failure}`, () => {
      const { target, recorded } = recordingTarget();
      respondWithAuthorizationFailure(target, row.failure);
      expect(recorded.status).toBe(row.status);
      expect(recorded.body).toEqual({ error: row.title, detail: row.detail });
    });
  }

  it('delegates to a published responder with exactly the helper value', () => {
    const received: ErrorResponseInit[] = [];
    const state = new Map<string, unknown>([[ERROR_RESPONDER_STATE_KEY, {
      respond(_target: ErrorResponderTarget, init: ErrorResponseInit): void {
        received.push(init);
      },
    }]]);
    const { target } = recordingTarget(state);
    respondWithAuthorizationFailure(target, 'authentication-required');
    expect(received).toEqual([authorizationFailureInit('authentication-required')]);
  });
});
