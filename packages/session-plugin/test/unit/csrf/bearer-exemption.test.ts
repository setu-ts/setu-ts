/**
 * The credential-based bearer rule (M113e, V9-27): a request carrying
 * `Authorization: Bearer <token>` skips form CSRF only when a `'header'`-
 * credential strategy authenticated it, as recorded under
 * `CREDENTIAL_SOURCE_STATE_KEY`, AND the request restored no session — the
 * session parked under `SESSION_STATE_KEY` is new (`isNew === true`) — and the
 * option resolves to the documented default.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IRequestContext, ISession } from '@setu-ts/common';
import { CREDENTIAL_SOURCE_STATE_KEY, SESSION_STATE_KEY } from '@setu-ts/common';

import { isBearerRequest, isCsrfExempt } from '../../../src/csrf/exclude.ts';
import { resolveCsrfConfig } from '../../../src/options.ts';

function headers(authorization?: string): Headers {
  return new Headers(authorization === undefined ? {} : { authorization });
}

function ctx(
  path: string,
  authorization?: string,
  state: Map<string, unknown> = new Map(),
): IRequestContext {
  return {
    request: { path, headers: headers(authorization) },
    state,
  } as unknown as IRequestContext;
}

/**
 * The state a request leaves behind: the credential source a strategy recorded
 * (or none, when nothing authenticated it) and, when present, the session
 * `session-plugin` parked for the request, carrying only `isNew`, the field the
 * bearer rule reads.
 */
function stateFor(source: 'header' | 'cookie' | undefined, isNew?: boolean): Map<string, unknown> {
  const state = new Map<string, unknown>();
  if (source !== undefined) state.set(CREDENTIAL_SOURCE_STATE_KEY, source);
  if (isNew !== undefined) state.set(SESSION_STATE_KEY, { isNew } as unknown as ISession);
  return state;
}

describe('isBearerRequest', () => {
  it.each([
    ['Bearer abc', true],
    ['bearer abc', true],
    ['BEARER\tabc', true],
    ['Bearer   eyJ.x.y', true],
    ['Bearer', false],
    ['Bearer ', false],
    ['Bearer \t ', false],
    ['Bearerabc', false],
    ['Basic dXNlcjpwYXNz', false],
    ['Token abc', false],
  ])('%j → %s', (value, expected) => {
    expect(isBearerRequest(headers(value))).toBe(expected);
  });

  it('is false with no Authorization header', () => {
    expect(isBearerRequest(headers())).toBe(false);
  });
});

describe('isCsrfExempt — the credential-based bearer rule', () => {
  it('exempts a bearer request a header strategy authenticated, with a new session', () => {
    expect(
      isCsrfExempt(
        ctx('/api', 'Bearer t', stateFor('header', true)),
        resolveCsrfConfig(),
        undefined,
      ),
    ).toBe(true);
  });

  it('verifies a bearer request whose session was restored (isNew false)', () => {
    expect(
      isCsrfExempt(
        ctx('/api', 'Bearer t', stateFor('header', false)),
        resolveCsrfConfig(),
        undefined,
      ),
    ).toBe(false);
  });

  it('verifies a bearer request when no session is parked (fails closed)', () => {
    expect(
      isCsrfExempt(ctx('/api', 'Bearer t', stateFor('header')), resolveCsrfConfig(), undefined),
    ).toBe(false);
  });

  it('verifies a bearer request the session cookie authenticated', () => {
    expect(
      isCsrfExempt(
        ctx('/api', 'Bearer t', stateFor('cookie', false)),
        resolveCsrfConfig(),
        undefined,
      ),
    ).toBe(false);
  });

  it('verifies a bearer request nothing authenticated, even with a new session (fails closed)', () => {
    expect(
      isCsrfExempt(
        ctx('/api', 'Bearer t', stateFor(undefined, true)),
        resolveCsrfConfig(),
        undefined,
      ),
    ).toBe(false);
  });

  it('verifies a header-authenticated bearer request when exemptBearer is false', () => {
    const config = resolveCsrfConfig({ exemptBearer: false });
    expect(isCsrfExempt(ctx('/api', 'Bearer t', stateFor('header', true)), config, undefined)).toBe(
      false,
    );
  });

  it('still honours a path exclusion when exemptBearer is false', () => {
    const config = resolveCsrfConfig({ exemptBearer: false });
    expect(isCsrfExempt(ctx('/rpc', 'Basic x', stateFor(undefined)), config, ['/rpc'])).toBe(true);
  });

  it('does not exempt Basic credentials, which browsers re-send by themselves', () => {
    expect(
      isCsrfExempt(
        ctx('/api', 'Basic x', stateFor('header', true)),
        resolveCsrfConfig(),
        undefined,
      ),
    ).toBe(false);
  });
});

describe('resolveCsrfConfig — exemptBearer', () => {
  it('defaults to true and honours false', () => {
    expect(resolveCsrfConfig().exemptBearer).toBe(true);
    expect(resolveCsrfConfig({ exemptBearer: false }).exemptBearer).toBe(false);
  });
});

describe('resolveCsrfConfig — exemptBearer validation (M113e audit L2)', () => {
  it.each([['false'], ['no'], [null], [0], [1]])('refuses the non-boolean %j', (value) => {
    expect(() => resolveCsrfConfig({ exemptBearer: value as unknown as boolean })).toThrow(
      new TypeError("SessionPlugin option 'csrf.exemptBearer' must be a boolean."),
    );
  });

  it('accepts both booleans and defaults to true', () => {
    expect(resolveCsrfConfig({ exemptBearer: false }).exemptBearer).toBe(false);
    expect(resolveCsrfConfig({ exemptBearer: true }).exemptBearer).toBe(true);
    expect(resolveCsrfConfig({}).exemptBearer).toBe(true);
  });
});
