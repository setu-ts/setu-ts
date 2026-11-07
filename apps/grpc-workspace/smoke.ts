import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { SOURCE_HOST_ARGS, startHost, stopHost, waitForHttp } from '../smoke-helpers.ts';
import type { Host } from '../smoke-helpers.ts';

const BILLING_PORT = 3410;
const ORDERS_PORT = 3411;

/** Fails (does not skip) with a clear message when the port is already taken. */
function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use; stop the process using it and re-run.`));
      } else {
        reject(error);
      }
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

// The two line items the smoke quotes, and the total the shared price table
// gives them: two widgets (999 each) and one gadget (1499).
const ITEMS = [
  { sku: 'widget', quantity: 2 },
  { sku: 'gadget', quantity: 1 },
] as const;
const EXPECTED_TOTAL = 2 * 999 + 1499;

const jsonPost = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('grpc-workspace example', () => {
  let billing: Host | undefined;
  let orders: Host | undefined;
  const root = fileURLToPath(new URL('.', import.meta.url));
  const billingUrl = `http://127.0.0.1:${BILLING_PORT}`;
  const ordersUrl = `http://127.0.0.1:${ORDERS_PORT}`;

  before(async () => {
    // Step 1: the members bind fixed ports; fail clearly rather than skip.
    await assertPortFree(BILLING_PORT);
    await assertPortFree(ORDERS_PORT);
    // Step 2: start billing, then orders, each from its own directory.
    billing = startHost(
      process.execPath,
      [...SOURCE_HOST_ARGS, 'main.ts'],
      { ...process.env },
      { cwd: join(root, 'apps', 'billing') },
    );
    orders = startHost(
      process.execPath,
      [...SOURCE_HOST_ARGS, 'main.ts'],
      { ...process.env },
      { cwd: join(root, 'apps', 'orders') },
    );
    // Step 3: wait for each member's /ready.
    // A 503 from /ready is not ready: wait for a 2xx.
    const isReady = (response: Response): boolean => response.ok;
    await waitForHttp(`${billingUrl}/ready`, { label: 'billing', timeoutMs: 30_000, isReady });
    await waitForHttp(`${ordersUrl}/ready`, { label: 'orders', timeoutMs: 30_000, isReady });
  });

  after(async () => {
    // Step 8: stop both (a host already stopped by step 7 is not an error).
    // A host is undefined when `before` failed before starting it, such as on a taken port.
    const started = [billing, orders].filter((host): host is Host => host !== undefined);
    const exitCodes = await Promise.all(started.map((host) => stopHost(host)));
    for (const code of exitCodes) {
      assert.equal(code, 0, `a member exited ${code} instead of 0`);
    }
  });

  // Step 4: create an order quoted by billing, then read it back.
  it('quotes two line items through orders and reads the stored order back', async () => {
    const created = await jsonPost(`${ordersUrl}/orders`, { items: [...ITEMS] });
    assert.equal(created.status, 201);
    const record = (await created.json()) as { id: string; items: unknown[]; totalCents: number };
    assert.equal(record.totalCents, EXPECTED_TOTAL);
    assert.ok(record.id.length > 0);

    const read = await fetch(`${ordersUrl}/orders/${record.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), record);
  });

  // Step 5: the same total, straight off billing's Quote procedure over Connect JSON.
  it('answers the same total on billing.v1.BillingService/Quote over Connect JSON', async () => {
    const response = await jsonPost(`${billingUrl}/grpc/billing.v1.BillingService/Quote`, {
      items: [...ITEMS],
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { totalCents: number | string };
    // int64 arrives as a JSON string; the total is the same cents either way.
    assert.equal(Number(body.totalCents), EXPECTED_TOTAL);
  });

  // Step 6: an unknown SKU answers 400; a zero quantity answers 400 before billing is called.
  it('answers 400 for an unknown SKU and for a zero quantity', async () => {
    const unknownSku = await jsonPost(`${ordersUrl}/orders`, {
      items: [{ sku: 'nope', quantity: 1 }],
    });
    assert.equal(unknownSku.status, 400);

    const zeroQuantity = await jsonPost(`${ordersUrl}/orders`, {
      items: [{ sku: 'widget', quantity: 0 }],
    });
    assert.equal(zeroQuantity.status, 400);
    // The schema's rfc9457 answer (an `errors` extension), not billing's: the
    // zero-quantity call never reached billing.
    const zeroProblem = (await zeroQuantity.json()) as { errors?: unknown[] };
    assert.ok(Array.isArray(zeroProblem.errors));
  });

  // Step 7: once billing has stopped, an order attempt answers 503.
  it('answers 503 once billing has stopped', async () => {
    assert.ok(billing !== undefined, 'billing was started in before');
    await stopHost(billing);
    const response = await jsonPost(`${ordersUrl}/orders`, { items: [...ITEMS] });
    assert.equal(response.status, 503);
  });
});
