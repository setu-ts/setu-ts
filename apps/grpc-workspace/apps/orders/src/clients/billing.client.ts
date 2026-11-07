import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { BillingService } from '@grpc-workspace/contracts';

/** The orders view of billing's `Quote` procedure — the real Connect client, or a test fake. */
export type BillingClient = Client<typeof BillingService>;

/** How long orders waits for billing before answering 503. */
export const BILLING_TIMEOUT_MS = 5_000;

/** Builds a Connect client for billing at the URL discovery resolved, with a deadline. */
export function createBillingClient(baseUrl: string): BillingClient {
  return createClient(
    BillingService,
    createConnectTransport({ baseUrl, defaultTimeoutMs: BILLING_TIMEOUT_MS }),
  );
}
