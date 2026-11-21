/**
 * Which responses the session middleware marks as per-visitor, so no shared cache (a CDN, a
 * reverse proxy, an in-process `cacheMiddleware`) stores one visitor's page for another.
 *
 * A response is per-visitor when any of these signals holds:
 *
 * - **S1** — the request restored a session holding application data (any key other than the
 *   reserved CSRF token and tenant binding). `Cache-Control: private, no-store` is set before the
 *   handler runs; `Vary: Cookie` follows at the first application read or after the handler.
 * - **S2** — the response carries the session cookie (a written commit or a destroy). Applied at the
 *   first application write, and again after the commit.
 * - **S3** — a CSRF token was read for this request. Applied at the read.
 *
 * A response is session-dependent when the application read one of its own keys and no signal
 * holds: it is the anonymous variant of a page, and gets `Vary: Cookie` only, at the first read.
 *
 * Not exported from the package barrel.
 *
 * @module
 */
import type { ILogger, IRequestContext, IResponse, ISession } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import type { SessionCommitOutcome, SessionCommitPolicy } from './session-service.ts';
import type { Session } from './session.ts';

/** The directive the plugin writes on a per-visitor response. */
export const PRIVATE_DIRECTIVE = 'private, no-store';

/** The most method-and-route pairs the public-directive warning remembers. */
export const WARNED_ROUTE_LIMIT = 1_000;

/** The longest route the warning logs or remembers. */
export const WARNED_ROUTE_LENGTH = 200;

/** Appends `Vary: Cookie` unless the response already varies on it (or on everything). */
export function appendVaryCookie(response: IResponse): void {
  const vary = response.snapshot().headers.get('vary');
  if (vary !== null) {
    const fields = vary.split(',').map((field) => field.trim().toLowerCase());
    if (fields.includes('cookie') || fields.includes('*')) {
      return;
    }
  }
  response.appendHeader('vary', 'Cookie');
}

/** Marks a response per-visitor: `Cache-Control: private, no-store` and `Vary: Cookie`. */
export function markPerVisitor(response: IResponse): void {
  response.header('cache-control', PRIVATE_DIRECTIVE);
  appendVaryCookie(response);
}

/**
 * Records that a CSRF token was read for this request (S3) and marks the response at once, so a
 * cache inside the session middleware sees the marking when it captures the response.
 */
export function noteCsrfTokenRead(ctx: IRequestContext, session: ISession): void {
  const tracked = session as Partial<Pick<Session, 'markCsrfTokenRead'>>;
  tracked.markCsrfTokenRead?.();
  // An explicit shared-cacheable directive the application already set is left for the
  // after-handler decision (kept, with a warning); `Vary: Cookie` keeps caches apart meanwhile.
  if (isSharedStorable(ctx.response.snapshot().headers.get('cache-control'))) {
    appendVaryCookie(ctx.response);
  } else {
    markPerVisitor(ctx.response);
  }
}

/**
 * Whether a `Cache-Control` value lets a shared cache store the response: present, and holding
 * neither `private` nor `no-store` (matched by directive name, case insensitively).
 */
export function isSharedStorable(cacheControl: string | null): boolean {
  if (cacheControl === null) {
    return false;
  }
  const names = cacheControl.split(',').map((part) => part.split('=')[0]!.trim().toLowerCase());
  return !names.includes('private') && !names.includes('no-store');
}

/**
 * Whether a request is a document navigation: `Sec-Fetch-Dest: document`, or, when the browser sends
 * no `Sec-Fetch-Dest` (Safari before 16.4), an `Accept` that includes `text/html`.
 */
export function isNavigation(headers: Headers): boolean {
  const dest = headers.get('sec-fetch-dest');
  if (dest !== null) {
    return dest.toLowerCase() === 'document';
  }
  return (headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

/**
 * The request path with each route parameter's value replaced by `:<name>`
 * (`/orders/123` → `/orders/:id`), cut to {@linkcode WARNED_ROUTE_LENGTH} characters, so no
 * identifier from the path reaches a log line.
 */
export function routeTemplate(path: string, params: Readonly<Record<string, string>>): string {
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    if (value !== '') names.set(value, name);
  }
  const route = path
    .split('/')
    .map((segment) => {
      const name = names.get(segment) ?? names.get(safeDecode(segment));
      return name === undefined ? segment : `:${name}`;
    })
    .join('/');
  return route.slice(0, WARNED_ROUTE_LENGTH);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The once-per-route warning for an application `Cache-Control` that lets a shared cache store a
 * per-visitor response. One instance per plugin; bounded to {@linkcode WARNED_ROUTE_LIMIT} entries,
 * after which one suppression line is logged and nothing else.
 */
export class PublicDirectiveWarnings {
  readonly #warned = new Set<string>();
  #suppressed = false;

  /** How many routes have been warned about. */
  get size(): number {
    return this.#warned.size;
  }

  /** Logs the warning for this request's route, once. */
  warn(ctx: IRequestContext, signal: 'session' | 'csrf-token'): void {
    if (!ctx.services.has(CAPABILITIES.LOGGER)) {
      return;
    }
    const method = ctx.request.method;
    const route = routeTemplate(ctx.request.path, ctx.params);
    const key = `${method} ${route}`;
    if (this.#warned.has(key)) {
      return;
    }
    const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
    if (this.#warned.size >= WARNED_ROUTE_LIMIT) {
      if (!this.#suppressed) {
        this.#suppressed = true;
        logger.warn('session-plugin: further shared-cacheable-directive warnings suppressed');
      }
      return;
    }
    this.#warned.add(key);
    logger.warn(
      'session-plugin: a per-visitor response carries a shared-cacheable Cache-Control set by the application',
      { method, route, signal },
    );
  }
}

/**
 * The marking for one request: applied before the handler (S1), at the first application write
 * (S2), and after the handler, where it decides the commit policy and the final headers.
 */
export class RequestCacheMarking {
  readonly #ctx: IRequestContext;
  readonly #session: Session;
  readonly #warnings: PublicDirectiveWarnings;
  readonly #restoredApplicationData: boolean;

  constructor(ctx: IRequestContext, session: Session, warnings: PublicDirectiveWarnings) {
    this.#ctx = ctx;
    this.#session = session;
    this.#warnings = warnings;
    // S1: a restored session holding application data. Read once, at load.
    this.#restoredApplicationData = !session.isNew && session.holdsApplicationData;
  }

  /**
   * Before the handler: S1 sets `Cache-Control: private, no-store`, so a session read late or a
   * cache registered inside the session middleware sees it; and the first application write (S2)
   * marks the response at once.
   */
  begin(): void {
    // A shared-cacheable directive an outer middleware already set is the application's own: it is
    // left for the after-handler decision rather than replaced.
    const preset = this.#ctx.response.snapshot().headers.get('cache-control');
    if (this.#restoredApplicationData && !isSharedStorable(preset)) {
      this.#ctx.response.header('cache-control', PRIVATE_DIRECTIVE);
    }
    this.#session.onFirstWrite(() => markPerVisitor(this.#ctx.response));
    // A page that read the session depends on the cookie: vary on it at once, so a cache inside
    // this middleware does not store the anonymous variant without `Vary: Cookie`.
    this.#session.onFirstRead(() => appendVaryCookie(this.#ctx.response));
  }

  /** The application's own directive, or `null` when it set none (or left the plugin's). */
  #applicationDirective(): string | null {
    const value = this.#ctx.response.snapshot().headers.get('cache-control');
    return value === null || value === PRIVATE_DIRECTIVE ? null : value;
  }

  /**
   * The commit policy this response allows: a response a shared cache may store gets no cookie for
   * a refresh-only commit or a reserved-keys-only new session; neither does a 404 to a request that
   * is not a document navigation (a missing asset starts no session).
   */
  policy(): SessionCommitPolicy {
    const storable = isSharedStorable(this.#applicationDirective());
    const missingAsset =
      this.#ctx.response.snapshot().status === 404 && !isNavigation(this.#ctx.request.headers);
    return { refresh: !storable, reservedOnlyNew: !storable && !missingAsset };
  }

  /**
   * After the handler and the commit (`outcome` is `undefined` when the request does not commit):
   * applies the final headers.
   */
  finish(outcome: SessionCommitOutcome | undefined): void {
    const response = this.#ctx.response;
    const s1 = this.#restoredApplicationData;
    const s2 = outcome === 'written';
    const s3 = this.#session.csrfTokenRead;
    const read = this.#session.wasReadByApplication;
    const directive = this.#applicationDirective();

    if (directive === null) {
      if (s1 || s2 || s3) {
        markPerVisitor(response);
      } else if (read) {
        appendVaryCookie(response);
      }
      return;
    }

    if (!isSharedStorable(directive)) {
      // An application directive that already keeps shared caches out is left as written.
      return;
    }

    if (s2) {
      // No explicit directive can make a session cookie safe to share.
      markPerVisitor(response);
      return;
    }
    if (s3 || (s1 && read)) {
      appendVaryCookie(response);
      this.#warnings.warn(this.#ctx, s3 ? 'csrf-token' : 'session');
      return;
    }
    if (read) {
      appendVaryCookie(response);
    }
    // S1 alone: a public asset fetched by a signed-in visitor keeps its directive, with no
    // `Vary: Cookie`, so assets stay cacheable for signed-in visitors.
  }
}
