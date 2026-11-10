import type { Client } from '@connectrpc/connect';
import type { IServiceRegistry } from '@setu-ts/common';
import { grpcClient } from '@setu-ts/grpc-plugin';
import { BillingService } from '@grpc-workspace/contracts';

/** The orders view of billing's `Quote` procedure — the plugin's client, or a test fake. */
export type BillingClient = Client<typeof BillingService>;

/**
 * Billing's client, from the `GrpcPlugin` this member registers for calling only
 * (`src/transport/index.ts`, rendered by the CLI from `dependsOn`).
 *
 * The plugin owns everything about the call: each one resolves `billing`
 * through service discovery and reports the outcome back (an instance that
 * refuses connections is ejected), every call to one instance shares one HTTP/2
 * session, a call has a 5 s deadline, and the active trace travels as
 * `traceparent`. The same arguments return the same client, so asking per
 * request costs a lookup.
 *
 * @param services - The application's service registry
 * @returns The client
 */
export function billingClient(services: IServiceRegistry): BillingClient {
  return grpcClient(services, BillingService, 'billing');
}
