import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:net';
import { startTestServer } from '../support/server.ts';
import { startFakeBilling } from '../support/fake-billing.ts';

const ITEMS = [
  { sku: 'widget', quantity: 2 },
  { sku: 'gadget', quantity: 1 },
] as const;
// Two widgets (999 each) and one gadget (1499), priced by the shared table.
const EXPECTED_TOTAL = 2 * 999 + 1499;

/** Fails with a clear message when the member's fixed port is taken. */
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
    probe.once('listening', () => {
      probe.close(() => resolve());
    });
    probe.listen(port, '127.0.0.1');
  });
}

describe('orders e2e', () => {
  it('creates and reads an order quoted by a fake billing over Connect', async () => {
    // The member's static discovery points billing at 127.0.0.1:3410, so the
    // fake must bind that exact port.
    await assertPortFree(3410);
    const fake = await startFakeBilling(3410);
    const server = await startTestServer();
    try {
      const list = await fetch(server.baseUrl + '/orders');
      assert.deepStrictEqual(list.status, 200);
      assert.deepStrictEqual(await list.json(), { items: [] });

      const created = await fetch(server.baseUrl + '/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [...ITEMS] }),
      });
      assert.deepStrictEqual(created.status, 201);
      const record: { id: string; items: unknown[]; totalCents: number } = await created.json();
      assert.deepStrictEqual(record.totalCents, EXPECTED_TOTAL);

      const read = await fetch(server.baseUrl + '/orders/' + record.id);
      assert.deepStrictEqual(read.status, 200);
      assert.deepStrictEqual(await read.json(), record);

      const zeroQuantity = await fetch(server.baseUrl + '/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ sku: 'widget', quantity: 0 }] }),
      });
      assert.deepStrictEqual(zeroQuantity.status, 400);
      // The schema's rfc9457 answer (an `errors` extension), not billing's:
      // the call never reached billing.
      const zeroQuantityProblem: { errors?: unknown[] } = await zeroQuantity.json();
      assert.ok(Array.isArray(zeroQuantityProblem.errors));

      const unknownSku = await fetch(server.baseUrl + '/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ sku: 'nope', quantity: 1 }] }),
      });
      assert.deepStrictEqual(unknownSku.status, 400);
      // Billing's `InvalidArgument`, remapped by the module to its own 400.
      const unknownSkuProblem: { detail?: string } = await unknownSku.json();
      assert.deepStrictEqual(unknownSkuProblem.detail, 'billing rejected the request.');

      fake.setUnavailable(true);
      const unavailable = await fetch(server.baseUrl + '/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [...ITEMS] }),
      });
      assert.deepStrictEqual(unavailable.status, 503);
      const body = await unavailable.text();
      // The mapping's own message, not the fake's — no upstream detail.
      const unavailableProblem: { detail?: string } = JSON.parse(body);
      assert.deepStrictEqual(unavailableProblem.detail, 'billing is unavailable.');
      assert.ok(!body.includes('the fake billing is off'));

      const spec = await fetch(server.baseUrl + '/openapi.json');
      const document: { paths: Record<string, unknown> } = await spec.json();
      assert.deepStrictEqual(Object.hasOwn(document.paths, '/orders'), true);
    } finally {
      await server.stop();
      await fake.stop();
    }
  });
});
