/**
 * Runtime detection — identifies the current JavaScript runtime by inspecting
 * well-known global properties.
 *
 * Accepts an injectable `globals` parameter (default `globalThis`) so every
 * detection branch is unit-testable by passing fake global shapes.
 *
 * @module
 */

import type { RuntimePlatform } from '@setu-ts/common';

/**
 * Detects the current runtime platform.
 *
 * Detection order (first match wins):
 * 1. Deno — `Deno` global exists
 * 2. Bun — `Bun` global exists (checked before Cloudflare to avoid false
 *    positives since Bun might also have `caches`)
 * 3. Cloudflare Workers — `caches` exists and `navigator.userAgent` contains
 *    'cloudflare', case-insensitively (a real Worker reports
 *    `'Cloudflare-Workers'`)
 * 4. Default — Node.js
 *
 * `process` is deliberately NOT consulted: `nodejs_compat` defines it on
 * Cloudflare Workers, so a `process`-based check would misreport every
 * Worker scaffolded with that flag — which is every Worker this CLI emits.
 *
 * @param globals - Injectable global scope (defaults to `globalThis`)
 * @returns Detected runtime platform
 */
export function detectRuntime(globals: GlobalScope = globalThis): RuntimePlatform {
  if (isDeno(globals)) {
    return 'deno';
  }
  if (isBun(globals)) {
    return 'bun';
  }
  if (isCloudflareWorkers(globals)) {
    return 'cloudflare-workers';
  }
  return 'node';
}

/** Checks if `Deno` global is present. */
function isDeno(globals: GlobalScope): boolean {
  return typeof (globals as { Deno?: unknown }).Deno !== 'undefined';
}

/** Checks if `Bun` global is present. */
function isBun(globals: GlobalScope): boolean {
  return typeof (globals as { Bun?: unknown }).Bun !== 'undefined';
}

/**
 * The user agent a real Worker reports, verified against workerd rather than
 * assumed: `navigator.userAgent === 'Cloudflare-Workers'`.
 *
 * Compared case-INSENSITIVELY, which is the whole defect this constant records.
 * The check used to be `userAgent.includes('cloudflare')` — lowercase — so it
 * never matched `'Cloudflare-Workers'` and every real Worker fell through to
 * `'node'`. Nothing caught it because the unit tests supplied
 * `'cloudflare-workers/v1'` and `'cloudflare'`, strings the platform does not
 * send: a test double that violated the real contract, and therefore tested the
 * double rather than the code.
 */
const CLOUDFLARE_USER_AGENT_MARKER = 'cloudflare';

/** Checks for Cloudflare Workers environment. */
function isCloudflareWorkers(globals: GlobalScope): boolean {
  const hasCaches = typeof (globals as { caches?: unknown }).caches !== 'undefined';
  const nav = (globals as { navigator?: { userAgent?: string } }).navigator;
  const isCloudflare = nav?.userAgent?.toLowerCase().includes(CLOUDFLARE_USER_AGENT_MARKER) ??
    false;
  return hasCaches && isCloudflare;
}

/**
 * Minimal global scope shape needed for detection.
 * Allows injecting a fake global for testing without `as` casts in test code.
 */
export interface GlobalScope {
  Deno?: unknown;
  Bun?: unknown;
  caches?: unknown;
  navigator?: { userAgent?: string };
}
