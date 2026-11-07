import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Code, ConnectError, createConnectRouter } from '@connectrpc/connect';
import {
  createFetchHandler,
  uResponseNotFound,
  type UniversalServerRequest,
} from '@connectrpc/connect/protocol';
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
 * so the orders side exercises the same wire format it will in production.
 *
 * @param port - The port to bind; ephemeral when omitted.
 */
export async function startFakeBilling(port?: number): Promise<FakeBilling> {
  let unavailable = false;
  const router = createConnectRouter();
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
  // The real member serves the plugin under `/grpc`; the fake does the same.
  const dispatch = (request: UniversalServerRequest) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/grpc/')) return Promise.resolve(uResponseNotFound);
    const handler = router.handlers.find(
      (entry) => entry.requestPath === pathname.slice('/grpc'.length),
    );
    return handler === undefined ? Promise.resolve(uResponseNotFound) : handler(request);
  };
  const handle = createFetchHandler(dispatch);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', (error: Error) => {
      res.destroy(error);
    });
    req.on('end', () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
        else headers.set(key, value);
      }
      const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        body,
      });
      handle(request)
        .then(async (response) => {
          res.statusCode = response.status;
          for (const [key, value] of response.headers) res.setHeader(key, value);
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => {
          res.statusCode = 500;
          res.end();
        });
    });
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
      }),
  };
}
