import { createServer } from 'node:http2';
import type { Http2Session } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { BillingService } from '@grpc-workspace/contracts';

/** The price table the fake quotes from — the member's own, mirrored here. */
export const FAKE_PRICE_CENTS: Readonly<Record<string, number>> = {
  widget: 999,
  gadget: 1499,
};

/** An in-process stand-in for the billing member. */
export interface FakeBilling {
  /** The origin the fake answers on; it serves the service under `/grpc`, like billing. */
  readonly baseUrl: string;
  /** Makes every `Quote` answer with a Connect `Unavailable` error. */
  setUnavailable(unavailable: boolean): void;
  /** Stops the fake; resolves once the server has closed. */
  stop(): Promise<void>;
}

/**
 * Starts a billing double: a real Connect server over the shared descriptors,
 * on HTTP/2 like billing, so the orders side exercises the same wire format and
 * transport it will in production.
 *
 * @param port - The port to bind; ephemeral when omitted.
 */
export async function startFakeBilling(port?: number): Promise<FakeBilling> {
  let unavailable = false;
  const sessions = new Set<Http2Session>();
  const server = createServer(
    connectNodeAdapter({
      // The real member serves the plugin under `/grpc`; the fake does the same.
      requestPathPrefix: '/grpc',
      routes(router) {
        router.service(BillingService, {
          quote(request: { items: { sku: string; quantity: number }[] }) {
            if (unavailable) throw new ConnectError('the fake billing is off', Code.Unavailable);
            let totalCents = 0;
            for (const item of request.items) {
              const priceCents = FAKE_PRICE_CENTS[item.sku];
              if (priceCents === undefined) {
                throw new ConnectError(`unknown SKU '${item.sku}'`, Code.InvalidArgument);
              }
              if (item.quantity <= 0) {
                throw new ConnectError('quantity must be a positive integer', Code.InvalidArgument);
              }
              totalCents += priceCents * item.quantity;
            }
            return { totalCents: BigInt(totalCents) };
          },
        });
      },
    }),
  );

  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    // Origin only: discovery appends the `/grpc` base path itself.
    baseUrl: `http://127.0.0.1:${address.port}`,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.close(() => resolve());
        // An HTTP/2 server's close waits for open sessions, and orders keeps
        // its session to billing open; end them so the fake can stop.
        for (const session of sessions) session.close();
      }),
  };
}
