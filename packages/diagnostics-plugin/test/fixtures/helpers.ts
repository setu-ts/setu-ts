/**
 * Shared test scaffolding for the diagnostics-plugin suite: a fake
 * framework request, a mutable monotonic clock, session builders, and the
 * client-side signing helper the server tests use to build honest (and
 * mutated) requests.
 *
 * This file is test-only and excluded from coverage measurement.
 *
 * @module
 */

import type {
  DiagnosticsBatch,
  DiagnosticsSnapshot,
  HttpMethod,
  IDiagnosticsSource,
  IRequest,
} from '@setu-ts/common';
import {
  canonicalBytes,
  hexEncode,
  importSessionKey,
  requestMacFields,
  signFields,
} from '../../src/security/authentication.ts';
import { DiagnosticsSessionState } from '../../src/security/session.ts';

/**
 * Fixed test credentials — synthetic, never real secrets.
 *
 * The 32-hex session ID is 'a' repeated 32 times; the key is the byte
 * sequence 0x00..0x1f.
 */
export const TEST_SESSION_ID = 'a'.repeat(32);
export const TEST_KEY_BYTES = new Uint8Array(32).map((_, i) => i);

/**
 * The fixed test port (inside 1024–65535; never bound by unit tests).
 */
export const TEST_PORT = 4919;
export const TEST_AUTHORITY = `127.0.0.1:${TEST_PORT}`;

/**
 * A fixed application-instance UUID for binding tests.
 */
export const TEST_INSTANCE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/**
 * A mutable monotonic clock tests drive by hand.
 */
export class MutableClock {
  now = 1_000;

  hrtime(): number {
    return this.now;
  }

  /**
   * Advances the clock.
   *
   * @param ms - Milliseconds to advance by
   */
  advance(ms: number): void {
    this.now += ms;
  }
}

/**
 * Builds a fake framework request. Only what the connector handler reads is
 * populated; body readers throw, because the protocol refuses bodies.
 *
 * @param init - The request shape
 * @returns The fake request
 */
export function fakeRequest(init: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
}): IRequest {
  const headers = new Headers(init.headers);
  return {
    method: (init.method ?? 'GET') as HttpMethod,
    url: init.url,
    path: new URL(init.url).pathname,
    headers,
    json: () => Promise.reject(new Error('no body in tests')),
    text: () => Promise.reject(new Error('no body in tests')),
    bytes: () => Promise.reject(new Error('no body in tests')),
  };
}

/**
 * Creates an ACTIVE test session on the given clock.
 *
 * @param subtle - The subtle crypto to use
 * @param clock - The clock to create the session on
 * @param ttlMs - Lifetime; defaults to one hour
 * @returns The session
 */
export function createTestSession(
  subtle: SubtleCrypto,
  clock: MutableClock,
  ttlMs = 3_600_000,
): Promise<DiagnosticsSessionState> {
  return DiagnosticsSessionState.create(
    subtle,
    TEST_SESSION_ID,
    TEST_KEY_BYTES,
    ttlMs,
    clock,
  );
}

/**
 * Signs an honest request the way the native client would: canonical
 * request fields over the given target and sequence.
 *
 * @param subtle - The subtle crypto to use
 * @param key - The imported session key
 * @param target - The canonical target
 * @param sequence - The sequence number
 * @param instance - The instance header value ('' on initial status)
 * @returns The lowercase hex MAC
 */
export async function signRequest(
  subtle: SubtleCrypto,
  key: CryptoKey,
  target: string,
  sequence: number,
  instance = '',
): Promise<string> {
  return await signFields(
    subtle,
    key,
    requestMacFields(TEST_SESSION_ID, instance, String(sequence), TEST_AUTHORITY, target),
  );
}

/**
 * Imports the fixed test key.
 *
 * @param subtle - The subtle crypto to use
 * @returns The imported HMAC key
 */
export function importTestKey(subtle: SubtleCrypto): Promise<CryptoKey> {
  return importSessionKey(subtle, TEST_KEY_BYTES);
}

/**
 * Builds a minimal valid M98a-style snapshot projection with a canary-free
 * allowed label and no other content.
 *
 * @param instanceId - The instance UUID to project (defaults to the test one)
 * @returns The snapshot object
 */
export function minimalSnapshot(
  instanceId: string | null = TEST_INSTANCE_ID,
): Record<string, unknown> {
  return {
    version: 1,
    instanceId,
    state: 'running',
    failureCode: null,
    nodes: [
      { id: 'p1', kind: 'plugin', label: 'catalog', version: '1.0.0' },
      { id: 'c1', kind: 'capability', label: 'catalog-items', registered: true },
    ],
    edges: [{ from: 'p1', kind: 'owns', to: 'c1' }],
    truncated: false,
    droppedEvents: 0,
  };
}

/**
 * Builds a minimal valid M98a-style batch projection.
 *
 * @param instanceId - The instance UUID to project
 * @param sequence - The event sequence to include (omit events entirely
 * when null)
 * @returns The batch object
 */
export function minimalBatch(
  instanceId: string | null = TEST_INSTANCE_ID,
  sequence: number | null = 1,
): Record<string, unknown> {
  return {
    version: 1,
    instanceId,
    events: sequence === null ? [] : [{
      sequence,
      operationId: `op${sequence}`,
      parentOperationId: null,
      kind: 'request',
      stage: 'request',
      nodeId: null,
      outcome: 'ok',
      atMs: 12,
      durationMs: 3,
    }],
    next: sequence ?? 0,
    lost: 0,
    closed: false,
  };
}

/**
 * A fake diagnostics source over fixed projections, with call counters the
 * tests assert against (a refusal must never read).
 *
 * @param snapshot - The snapshot to serve
 * @param batch - The batch to serve
 * @returns The source plus its call counters
 */
export function fakeSource(
  snapshot: Record<string, unknown>,
  batch: Record<string, unknown>,
): IDiagnosticsSource & { readonly snapshotCalls: number; readonly readCalls: number } {
  let snapshotCalls = 0;
  let readCalls = 0;
  return {
    get snapshotCalls(): number {
      return snapshotCalls;
    },
    get readCalls(): number {
      return readCalls;
    },
    snapshot(): DiagnosticsSnapshot {
      snapshotCalls += 1;
      return snapshot as unknown as DiagnosticsSnapshot;
    },
    read(): DiagnosticsBatch {
      readCalls += 1;
      return batch as unknown as DiagnosticsBatch;
    },
  };
}

/**
 * Encodes a string as UTF-8 — used by canonical-bytes assertions that build
 * their expected bytes INDEPENDENTLY of the production helpers.
 *
 * @param text - The text to encode
 * @returns The bytes
 */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  // `as` needed because TextEncoder's lib type is the wider
  // `Uint8Array<ArrayBufferLike>`; the runtime value is always
  // ArrayBuffer-backed, which is what BufferSource consumers require.
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/**
 * The hex encoder re-exported for fixture generation.
 *
 * @param bytes - Bytes to encode
 * @returns Lowercase hex
 */
export function toHex(bytes: Uint8Array): string {
  return hexEncode(bytes);
}

/**
 * Exposes the canonical-bytes helper for independent fixture building.
 *
 * @param fields - Canonical fields
 * @returns The exact MAC-covered bytes
 */
export function canonicalFixtureBytes(fields: readonly string[]): Uint8Array {
  return canonicalBytes(fields);
}
