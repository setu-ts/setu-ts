/**
 * The cache-marking decisions, signal by signal and row by row.
 */
import { describe, expect, it } from 'vitest';
import type { ILogger, IRequestContext } from '@setu-ts/common';
import { CAPABILITIES, PER_VISITOR_RESPONSE_STATE_KEY } from '@setu-ts/common';

import {
  appendVaryCookie,
  isNavigation,
  isSharedStorable,
  noteCsrfTokenRead,
  PRIVATE_DIRECTIVE,
  PublicDirectiveWarnings,
  RequestCacheMarking,
  routeTemplate,
  WARNED_ROUTE_LIMIT,
} from '../../../src/services/cache-marking.ts';
import type { SessionCommitOutcome } from '../../../src/services/session-service.ts';
import { createSession, Session } from '../../../src/services/session.ts';
import type { TestContext } from '../../fixtures/context.ts';
import { makeClock, makeContext } from '../../fixtures/context.ts';

const NOW = 1_700_000_000_000;

function restored(data: Record<string, unknown>): Session {
  return new Session({ id: 'sid', data, exp: NOW + 60_000, seen: NOW }, false, () => 'n', true);
}

function fresh(): Session {
  return createSession(NOW, 60_000, makeClock(NOW).uuid);
}

function withLogger(t: TestContext): Array<[string, unknown]> {
  const lines: Array<[string, unknown]> = [];
  t.registry.register(CAPABILITIES.LOGGER, {
    warn: (message: string, fields?: unknown) => lines.push([message, fields]),
  } as unknown as ILogger);
  return lines;
}

interface Run {
  readonly session: Session;
  readonly directive?: string;
  readonly outcome?: SessionCommitOutcome;
  readonly read?: boolean;
  readonly csrf?: boolean;
}

function run(spec: Run, warnings = new PublicDirectiveWarnings()) {
  const t = makeContext();
  const lines = withLogger(t);
  const marking = new RequestCacheMarking(t.ctx, spec.session, warnings);
  marking.begin();
  const afterBegin = t.response.headers.get('cache-control');
  if (spec.read === true) spec.session.get('userId');
  if (spec.csrf === true) noteCsrfTokenRead(t.ctx, spec.session);
  if (spec.directive !== undefined) t.response.header('cache-control', spec.directive);
  marking.finish(spec.outcome);
  return {
    afterBegin,
    cacheControl: t.response.headers.get('cache-control'),
    vary: t.response.headers.get('vary'),
    lines,
  };
}

const SIGNED_IN = () => restored({ userId: 'u1' });
const PUBLIC = 'public, s-maxage=60';

describe('signals and the after-handler decision', () => {
  it('S1 marks before the handler, and private, no-store with Vary after it', () => {
    const r = run({ session: SIGNED_IN() });
    expect(r.afterBegin).toBe(PRIVATE_DIRECTIVE);
    expect([r.cacheControl, r.vary]).toEqual([PRIVATE_DIRECTIVE, 'Cookie']);
  });

  it('a restored reserved-only session is not S1', () => {
    const r = run({ session: restored({ __csrf: 't' }) });
    expect([r.afterBegin, r.cacheControl, r.vary]).toEqual([null, null, null]);
  });

  it('S2 (a written commit) marks a response with no directive', () => {
    const r = run({ session: fresh(), outcome: 'written' });
    expect([r.cacheControl, r.vary]).toEqual([PRIVATE_DIRECTIVE, 'Cookie']);
  });

  it('S3 (a token read) marks at the read', () => {
    const t = makeContext();
    const session = fresh();
    noteCsrfTokenRead(t.ctx, session);
    expect(t.response.headers.get('cache-control')).toBe(PRIVATE_DIRECTIVE);
    expect(session.csrfTokenRead).toBe(true);
  });

  it('a session-dependent page gets Vary: Cookie only', () => {
    const r = run({ session: fresh(), read: true });
    expect([r.cacheControl, r.vary]).toEqual([null, 'Cookie']);
  });

  it('nothing at all for an untouched anonymous session', () => {
    const r = run({ session: fresh(), outcome: 'skipped' });
    expect([r.cacheControl, r.vary]).toEqual([null, null]);
  });

  it('a shared-storable directive with a session cookie becomes private', () => {
    const r = run({ session: fresh(), directive: PUBLIC, outcome: 'written' });
    expect([r.cacheControl, r.vary, r.lines]).toEqual([PRIVATE_DIRECTIVE, 'Cookie', []]);
  });

  it('S1 alone (a public asset for a signed-in visitor) keeps the directive, no Vary, no warning', () => {
    const r = run({ session: SIGNED_IN(), directive: PUBLIC, outcome: 'skipped' });
    expect([r.cacheControl, r.vary, r.lines]).toEqual([PUBLIC, null, []]);
  });

  it('S1 with a read keeps the directive, adds Vary and warns', () => {
    const r = run({ session: SIGNED_IN(), directive: PUBLIC, read: true });
    expect([r.cacheControl, r.vary]).toEqual([PUBLIC, 'Cookie']);
    expect(r.lines).toEqual([
      [
        'session-plugin: a per-visitor response carries a shared-cacheable Cache-Control set by the application',
        { method: 'GET', route: '/', signal: 'session' },
      ],
    ]);
  });

  it('S3 keeps the directive, keeps Vary and warns with the csrf-token signal', () => {
    const t = makeContext();
    const lines = withLogger(t);
    const session = fresh();
    const marking = new RequestCacheMarking(t.ctx, session, new PublicDirectiveWarnings());
    marking.begin();
    t.response.header('cache-control', PUBLIC);
    noteCsrfTokenRead(t.ctx, session);
    marking.finish('skipped');
    expect(t.response.headers.get('cache-control')).toBe(PUBLIC);
    expect(t.response.headers.get('vary')).toBe('Cookie');
    expect(lines[0]![1]).toEqual({ method: 'GET', route: '/', signal: 'csrf-token' });
  });

  it('a CSRF token read flags the response per-visitor, even under an explicit public', () => {
    const t = makeContext();
    t.response.header('cache-control', PUBLIC);
    noteCsrfTokenRead(t.ctx, fresh());
    expect(t.ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY)).toBe(true);
  });

  it("a read of a signed-in visitor's session flags the response; an anonymous read does not", () => {
    const signedIn = makeContext();
    const session = SIGNED_IN();
    new RequestCacheMarking(signedIn.ctx, session, new PublicDirectiveWarnings()).begin();
    session.get('userId');
    expect(signedIn.ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY)).toBe(true);
    const anonymous = makeContext();
    const guest = fresh();
    new RequestCacheMarking(anonymous.ctx, guest, new PublicDirectiveWarnings()).begin();
    guest.get('userId');
    expect(anonymous.ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY)).toBeUndefined();
  });

  it('a malformed directive is no application directive: the plugin marks the response', () => {
    const malformed = 'public, max-age=300, x="a';
    expect(isSharedStorable(malformed)).toBe(false);
    const r = run({ session: SIGNED_IN(), directive: malformed, read: true });
    expect([r.cacheControl, r.vary]).toEqual(['private, no-store', 'Cookie']);
  });

  it('a quoted Cache-Control argument naming private does not make public non-storable', () => {
    expect(isSharedStorable('public, example="a,private"')).toBe(true);
    expect(isSharedStorable('public, private="set-cookie"')).toBe(false);
  });

  it('the first application write flags the response per-visitor for a cache inside', () => {
    const t = makeContext();
    const session = fresh();
    const marking = new RequestCacheMarking(t.ctx, session, new PublicDirectiveWarnings());
    marking.begin();
    expect(t.ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY)).toBeUndefined();
    session.set('cart', 'c1');
    expect(t.ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY)).toBe(true);
  });

  // An outer default must not let a cache inside the session middleware store a signed-in page that
  // never reads the session API (it may render `ctx.request.user`).
  it('S1 replaces a shared-cacheable directive an outer middleware set before it', () => {
    const t = makeContext();
    t.response.header('cache-control', 'public, max-age=3600');
    const marking = new RequestCacheMarking(t.ctx, SIGNED_IN(), new PublicDirectiveWarnings());
    marking.begin();
    expect(t.response.headers.get('cache-control')).toBe('private, no-store');
    marking.finish('skipped');
    expect(t.response.headers.get('cache-control')).toBe('private, no-store');
    expect(t.response.headers.get('vary')).toBe('Cookie');
  });

  it('a session-dependent page with a public directive keeps it and gets Vary', () => {
    const r = run({ session: fresh(), directive: PUBLIC, read: true });
    expect([r.cacheControl, r.vary, r.lines]).toEqual([PUBLIC, 'Cookie', []]);
  });

  it('any other application directive is left as written', () => {
    const r = run({ session: SIGNED_IN(), directive: 'private, max-age=60', outcome: 'written' });
    expect([r.cacheControl, r.vary]).toEqual(['private, max-age=60', null]);
  });

  it('the first application write marks at once; a reserved write does not', () => {
    const t = makeContext();
    const session = fresh();
    new RequestCacheMarking(t.ctx, session, new PublicDirectiveWarnings()).begin();
    session.set('__csrf', 'token');
    expect(t.response.headers.get('cache-control')).toBeNull();
    session.set('cart', 1);
    expect(t.response.headers.get('cache-control')).toBe(PRIVATE_DIRECTIVE);
  });
});

describe('the commit policy', () => {
  function policy(directive: string | undefined, status: number, headers: Record<string, string>) {
    const t = makeContext({ headers });
    const marking = new RequestCacheMarking(t.ctx, fresh(), new PublicDirectiveWarnings());
    if (directive !== undefined) t.response.header('cache-control', directive);
    t.response.status(status);
    return marking.policy();
  }

  it('allows every commit on an ordinary response', () => {
    expect(policy(undefined, 200, {})).toEqual({ refresh: true, reservedOnlyNew: true });
    expect(policy(PRIVATE_DIRECTIVE, 200, {})).toEqual({ refresh: true, reservedOnlyNew: true });
  });

  it('skips refresh-only and reserved-only commits on a shared-storable response', () => {
    expect(policy(PUBLIC, 200, {})).toEqual({ refresh: false, reservedOnlyNew: false });
  });

  it('skips a reserved-only new session on a 404 that is not a navigation', () => {
    expect(policy(undefined, 404, { 'sec-fetch-dest': 'image' }).reservedOnlyNew).toBe(false);
    expect(policy(undefined, 404, {}).reservedOnlyNew).toBe(false);
    expect(policy(undefined, 404, { 'sec-fetch-dest': 'document' }).reservedOnlyNew).toBe(true);
    expect(policy(undefined, 404, { accept: 'text/html' }).reservedOnlyNew).toBe(true);
  });
});

describe('helpers', () => {
  it('isSharedStorable matches directive names', () => {
    expect(isSharedStorable(null)).toBe(false);
    expect(isSharedStorable('public, max-age=60')).toBe(true);
    expect(isSharedStorable('no-cache')).toBe(true);
    expect(isSharedStorable('Private')).toBe(false);
    expect(isSharedStorable('private="set-cookie"')).toBe(false);
    expect(isSharedStorable('max-age=0, NO-STORE')).toBe(false);
  });

  it('isNavigation honours Sec-Fetch-Dest first, then Accept', () => {
    expect(isNavigation(new Headers({ 'sec-fetch-dest': 'Document' }))).toBe(true);
    expect(isNavigation(new Headers({ 'sec-fetch-dest': 'image', accept: 'text/html' }))).toBe(
      false,
    );
    expect(isNavigation(new Headers({ accept: 'text/html' }))).toBe(true);
    expect(isNavigation(new Headers())).toBe(false);
  });

  it('appendVaryCookie never duplicates and respects Vary: *', () => {
    for (const [initial, expected] of [
      [null, 'Cookie'],
      ['Accept', 'Accept, Cookie'],
      ['accept, cookie', 'accept, cookie'],
      ['*', '*'],
    ] as const) {
      const t = makeContext();
      if (initial !== null) t.response.header('vary', initial);
      appendVaryCookie(t.response);
      expect(t.response.headers.get('vary')).toBe(expected);
    }
  });

  it('routeTemplate replaces parameter values, decoded or not, and cuts at 200 characters', () => {
    expect(routeTemplate('/orders/123/items/a%20b', { id: '123', item: 'a b' })).toBe(
      '/orders/:id/items/:item',
    );
    expect(routeTemplate('/bad/%E0%A4%A', { x: 'nothing' })).toBe('/bad/%E0%A4%A');
    expect(routeTemplate('/p', { empty: '' })).toBe('/p');
    expect(routeTemplate(`/${'a'.repeat(300)}`, {})).toHaveLength(200);
  });
});

describe('the public-directive warning bound', () => {
  function warnFor(warnings: PublicDirectiveWarnings, t: TestContext, path: string): void {
    (t.ctx.request as { path: string }).path = path;
    warnings.warn(t.ctx as IRequestContext, 'session');
  }

  it('warns once per route, then logs one suppression line past the limit', () => {
    const warnings = new PublicDirectiveWarnings();
    const t = makeContext();
    const lines = withLogger(t);
    for (let i = 0; i < WARNED_ROUTE_LIMIT; i++) warnFor(warnings, t, `/r/${i}`);
    warnFor(warnings, t, '/r/0');
    expect(lines).toHaveLength(WARNED_ROUTE_LIMIT);
    warnFor(warnings, t, '/r/extra-1');
    warnFor(warnings, t, '/r/extra-2');
    expect(lines).toHaveLength(WARNED_ROUTE_LIMIT + 1);
    expect(lines.at(-1)).toEqual([
      'session-plugin: further shared-cacheable-directive warnings suppressed',
      undefined,
    ]);
    expect(warnings.size).toBe(WARNED_ROUTE_LIMIT);
  });

  it('logs nothing without a logger', () => {
    const warnings = new PublicDirectiveWarnings();
    warnings.warn(makeContext().ctx, 'session');
    expect(warnings.size).toBe(0);
  });

  it('carries no query, id or cookie in its fields', () => {
    const warnings = new PublicDirectiveWarnings();
    const t = makeContext({
      url: 'http://localhost/orders/42?token=secret',
      headers: { cookie: 'setu_session=abc' },
    });
    (t.ctx as { params: Record<string, string> }).params = { id: '42' };
    const lines = withLogger(t);
    warnings.warn(t.ctx, 'session');
    expect(lines).toEqual([
      [
        'session-plugin: a per-visitor response carries a shared-cacheable Cache-Control set by the application',
        { method: 'GET', route: '/orders/:id', signal: 'session' },
      ],
    ]);
  });
});
