/**
 * Runtime detection — identifies the current JavaScript runtime by inspecting
 * well-known global properties.
 *
 * Accepts an injectable `globals` parameter (default `globalThis`) so every
 * detection branch is unit-testable by passing fake global shapes.
 *
 * @module
 */

import type { RuntimePlatform } from '@hono-enterprise/common';

/**
 * Detects the current runtime platform.
 *
 * Detection order (first match wins):
 * 1. Deno — `Deno` global exists
 * 2. Bun — `Bun` global exists (checked before Cloudflare to avoid false
 *    positives since Bun might also have `caches`)
 * 3. Cloudflare Workers — `caches` exists and `navigator.userAgent` includes
 *    'cloudflare'
 * 4. Default — Node.js
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

/** Checks for Cloudflare Workers environment. */
function isCloudflareWorkers(globals: GlobalScope): boolean {
  const hasCaches = typeof (globals as { caches?: unknown }).caches !== 'undefined';
  const nav = (globals as { navigator?: { userAgent?: string } }).navigator;
  const isCloudflare = nav?.userAgent?.includes('cloudflare') ?? false;
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
