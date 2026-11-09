import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { BillingService } from '@grpc-workspace/contracts';

/** The orders view of billing's `Quote` procedure — the real Connect client, or a test fake. */
export type BillingClient = Client<typeof BillingService>;

/** How long orders waits for billing before answering 503. */
export const BILLING_TIMEOUT_MS = 5_000;

/**
 * Builds a Connect client for billing at the URL discovery resolved, with a deadline.
 *
 * Connect protocol over HTTP/2: billing serves `RuntimePlugin({ http2: true })`, so
 * the transport speaks HTTP/2 with prior knowledge to its `http://` URL and keeps
 * one session open for every call, as a grpc-js client would.
 */
export function createBillingClient(baseUrl: string): BillingClient {
  return createClient(
    BillingService,
    createConnectTransport({ baseUrl, httpVersion: '2', defaultTimeoutMs: BILLING_TIMEOUT_MS }),
  );
}
