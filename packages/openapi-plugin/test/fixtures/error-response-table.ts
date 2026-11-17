/**
 * The M137b gate as data: each row is a route's REAL middleware set and the
 * statuses and headers the generated document must list for it. The unit test
 * runs the table against the generator; the live test runs the same table
 * against a running app and triggers every documented status, so the document
 * cannot claim a response the route never sends.
 *
 * @module
 */
import { z } from 'zod-v4';
import type { MiddlewareFunction } from '@setu-ts/common';
import {
  publicRoute,
  rateLimitMiddleware,
  requireAuth,
  requireMfa,
  requireRole,
  requireScopes,
} from '@setu-ts/auth-plugin';
import { idempotent } from '@setu-ts/idempotency-plugin';
import { validateBody } from '@setu-ts/validation-plugin';

/** The bearer scheme every live row documents against. */
export const BEARER_SCHEMES = { bearerAuth: { type: 'http', scheme: 'bearer' } } as const;

/** A principal a live request signs a token for. */
export interface LivePrincipal {
  readonly sub: string;
  readonly scope?: string;
  readonly act?: object;
}

/** One request a live trigger sends. */
export interface LiveRequest {
  /** Principal to sign a token for; anonymous when absent. */
  readonly as?: LivePrincipal;
  /** Extra headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Raw body. */
  readonly body?: string;
}

/**
 * How to make the route answer one status: requests sent in order; the LAST
 * response is the one asserted. `concurrent` sends the requests together and
 * asserts the response carrying the status (the idempotency `409`).
 */
export interface LiveTrigger {
  readonly requests: readonly LiveRequest[];
  readonly concurrent?: true;
}

/** One table row. */
export interface ErrorTableRow {
  readonly name: string;
  readonly method: 'GET' | 'POST';
  readonly middleware: () => MiddlewareFunction[];
  /** Expected derived error statuses → header names (sorted). */
  readonly errors: Readonly<Record<string, readonly string[]>>;
  /** Expected derived headers on the success response (sorted). */
  readonly successHeaders: readonly string[];
  /** Headers the live success/error responses must NOT carry (source-guaranteed absence). */
  readonly absent?: readonly string[];
  /** Live trigger per documented status; `'2xx'` is the success response, fired FIRST. */
  readonly live: Readonly<Record<string, LiveTrigger>>;
  /**
   * Documented statuses the live test does not trigger on THIS row, each with
   * the reason; every other documented status must have a trigger.
   */
  readonly liveSkip?: Readonly<Record<string, string>>;
}

const json = { 'content-type': 'application/json' };
const user = (sub: string): LivePrincipal => ({ sub });

/** The table. Every route-level brand kind and each documented status. */
export const ERROR_RESPONSE_TABLE: readonly ErrorTableRow[] = [
  {
    name: 'requireAuth() documents 401 only',
    method: 'GET',
    middleware: () => [requireAuth()],
    errors: { '401': ['WWW-Authenticate'] },
    successHeaders: [],
    live: {
      '401': { requests: [{}] },
      '2xx': { requests: [{ as: user('a') }] },
    },
  },
  {
    name: "requireAuth({ delegation: 'forbid' }) documents 401 and 403",
    method: 'GET',
    middleware: () => [requireAuth({ delegation: 'forbid' })],
    errors: { '401': ['WWW-Authenticate'], '403': [] },
    successHeaders: [],
    live: {
      '401': { requests: [{}] },
      '403': { requests: [{ as: { sub: 'a', act: { sub: 'agent' } } }] },
      '2xx': { requests: [{ as: user('a') }] },
    },
  },
  {
    name: "requireRole('admin') documents 401 and 403",
    method: 'GET',
    middleware: () => [requireRole('admin')],
    errors: { '401': ['WWW-Authenticate'], '403': [] },
    successHeaders: [],
    live: {
      '401': { requests: [{}] },
      '403': { requests: [{ as: user('a') }] },
    },
  },
  {
    name: 'requireScopes documents the scope challenge on 403',
    method: 'GET',
    middleware: () => [requireScopes('items:write')],
    errors: { '401': ['WWW-Authenticate'], '403': ['WWW-Authenticate'] },
    successHeaders: [],
    live: {
      '401': { requests: [{}] },
      '403': { requests: [{ as: { sub: 'a', scope: 'items:read' } }] },
      '2xx': { requests: [{ as: { sub: 'a', scope: 'items:write' } }] },
    },
  },
  {
    name: 'requireMfa() documents 401 and 403',
    method: 'GET',
    middleware: () => [requireMfa()],
    errors: { '401': ['WWW-Authenticate'], '403': [] },
    successHeaders: [],
    live: {
      '401': { requests: [{}] },
      '403': { requests: [{ as: user('a') }] },
    },
  },
  {
    name: 'publicRoute() documents nothing',
    method: 'GET',
    middleware: () => [publicRoute()],
    errors: {},
    successHeaders: [],
    live: { '2xx': { requests: [{}] } },
  },
  {
    name: 'a body validator documents 400 and 415',
    method: 'POST',
    middleware: () => [validateBody(z.object({ sku: z.string() }))],
    errors: { '400': [], '415': [] },
    successHeaders: [],
    live: {
      '400': { requests: [{ headers: json, body: '{"sku":1}' }] },
      '415': { requests: [{ headers: { 'content-type': 'text/plain' }, body: 'x' }] },
      '2xx': { requests: [{ headers: json, body: '{"sku":"a"}' }] },
    },
  },
  {
    name: 'a rate limiter documents 429 with its standard fields',
    method: 'GET',
    middleware: () => [rateLimitMiddleware({ windowMs: 60_000, max: 1, keyGenerator: () => 'rl' })],
    errors: { '429': ['RateLimit', 'RateLimit-Policy', 'Retry-After'] },
    successHeaders: ['RateLimit', 'RateLimit-Policy'],
    live: {
      '2xx': { requests: [{}] },
      '429': { requests: [{}, {}] },
    },
  },
  {
    name: 'a rate limiter without standard fields documents Retry-After only',
    method: 'GET',
    middleware: () => [
      rateLimitMiddleware({
        windowMs: 60_000,
        max: 1,
        standardHeaders: false,
        keyGenerator: () => 'rl-plain',
      }),
    ],
    errors: { '429': ['Retry-After'] },
    successHeaders: [],
    absent: ['RateLimit', 'RateLimit-Policy'],
    live: {
      '2xx': { requests: [{}] },
      '429': { requests: [{}, {}] },
    },
  },
  {
    name: 'idempotent() documents its refusals and the replay header',
    method: 'POST',
    middleware: () => [idempotent()],
    errors: { '400': [], '401': ['WWW-Authenticate'], '409': [], '422': [], '429': [] },
    successHeaders: ['Idempotent-Replayed'],
    live: {
      '400': { requests: [{ as: user('i400'), headers: json, body: '{}' }] },
      '401': { requests: [{ headers: { ...json, 'idempotency-key': 'k401' }, body: '{}' }] },
      '409': {
        concurrent: true,
        requests: [
          { as: user('i409'), headers: { ...json, 'idempotency-key': 'k409' }, body: '{}' },
          { as: user('i409'), headers: { ...json, 'idempotency-key': 'k409' }, body: '{}' },
        ],
      },
      '422': {
        requests: [
          { as: user('i422'), headers: { ...json, 'idempotency-key': 'k422' }, body: '{"a":1}' },
          { as: user('i422'), headers: { ...json, 'idempotency-key': 'k422' }, body: '{"a":2}' },
        ],
      },
      '429': {
        requests: [
          { as: user('i429'), headers: { ...json, 'idempotency-key': 'k429a' }, body: '{}' },
          { as: user('i429'), headers: { ...json, 'idempotency-key': 'k429b' }, body: '{}' },
        ],
      },
      '2xx': {
        requests: [
          { as: user('i2xx'), headers: { ...json, 'idempotency-key': 'k2xx' }, body: '{}' },
          { as: user('i2xx'), headers: { ...json, 'idempotency-key': 'k2xx' }, body: '{}' },
        ],
      },
    },
  },
  {
    name: "idempotent({ principal: 'optional' }) documents no 401",
    method: 'POST',
    middleware: () => [idempotent({ principal: 'optional', required: false })],
    errors: { '400': [], '409': [], '422': [], '429': [] },
    successHeaders: ['Idempotent-Replayed'],
    live: {
      '400': { requests: [{ headers: { ...json, 'idempotency-key': ' bad key ' }, body: '{}' }] },
      // Principals are optional here, not refused: each trigger signs in as
      // its own caller so the per-scope entry cap does not interfere.
      '422': {
        requests: [
          { as: user('o422'), headers: { ...json, 'idempotency-key': 'o422' }, body: '{"a":1}' },
          { as: user('o422'), headers: { ...json, 'idempotency-key': 'o422' }, body: '{"a":2}' },
        ],
      },
      // `Idempotent-Replayed` is sent on a replay, so the success trigger replays.
      '2xx': {
        requests: [
          { as: user('o2xx'), headers: { ...json, 'idempotency-key': 'o2xx' }, body: '{}' },
          { as: user('o2xx'), headers: { ...json, 'idempotency-key': 'o2xx' }, body: '{}' },
        ],
      },
    },
    liveSkip: {
      '409': 'the same refusal the idempotent() row triggers; anonymous callers share one scope',
      '429': 'the same refusal the idempotent() row triggers; anonymous callers share one scope',
    },
  },
  {
    name: 'idempotent() on GET documents nothing',
    method: 'GET',
    middleware: () => [idempotent()],
    errors: {},
    successHeaders: [],
    live: { '2xx': { requests: [{}] } },
  },
];
