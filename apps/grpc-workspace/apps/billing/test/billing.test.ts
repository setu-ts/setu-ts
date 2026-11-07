import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTestApp } from '@setu-ts/testing';
import { createApp } from '../setu.config.ts';

const QUOTE = '/grpc/billing.v1.BillingService/Quote';

/** Calls `Quote` over the Connect protocol with a JSON body, as a client would. */
async function quote(sku: string): Promise<{ statusCode: number; body: unknown }> {
  const app = await createTestApp({ app: await createApp() });
  try {
    const response = await app.inject({
      method: 'POST',
      url: QUOTE,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ sku, quantity: 2 }] }),
    });
    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await app.stop();
  }
}

describe('BillingService.Quote', () => {
  it('prices a known SKU', async () => {
    assert.deepStrictEqual(await quote('widget'), {
      statusCode: 200,
      body: { totalCents: '1998' },
    });
  });

  // Names an object literal would inherit: each is unknown, not a crash.
  for (const sku of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    it(`refuses the unknown SKU '${sku}' as invalid_argument`, async () => {
      assert.deepStrictEqual(await quote(sku), {
        statusCode: 400,
        body: { code: 'invalid_argument', message: `unknown SKU '${sku}'` },
      });
    });
  }
});
