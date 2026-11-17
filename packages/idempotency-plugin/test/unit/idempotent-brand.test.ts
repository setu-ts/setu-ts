import { it, expect } from 'vitest';
import { CAPABILITIES, idempotencyMetadataOf } from '@setu-ts/common';
import { createTestContext, MockServiceRegistry } from '@setu-ts/testing';
import { idempotent } from '../../src/middleware/idempotent.ts';
import { resolveDefaults } from '../../src/core/options.ts';
import { IdempotencyService } from '../../src/service/idempotency-service.ts';
import { MemoryIdempotencyStore } from '../../src/stores/memory-store.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';
it('brands both entry points and shares non-default configuration behavior', async () => {
  const runtime = createClockRuntime();
  const service = new IdempotencyService({
    transactionalConfigured: false,
    store: new MemoryIdempotencyStore(),
    runtime,
    logger: () => undefined,
    defaults: resolveDefaults({ leaseMs: 12345, ttlMs: 99999 }),
  });
  const services = new MockServiceRegistry();
  services.register(CAPABILITIES.IDEMPOTENCY, service);
  for (const middleware of [
    idempotent({ namespace: 'brand-test', required: false }),
    service.middleware({ namespace: 'brand-test', required: false }),
  ]) {
    expect(idempotencyMetadataOf(middleware)).toEqual({
      idempotent: true,
      keyHeader: 'Idempotency-Key',
      required: false,
      principalRequired: true,
    });
    let calls = 0;
    const ctx = createTestContext({ runtime, services, request: { method: 'POST' } });
    await middleware(ctx, () => {
      calls++;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(ctx.response.snapshot().status).toBe(200);
  }
  const control = createTestContext({ runtime, services, request: { method: 'POST' } });
  let downstream = false;
  await service.middleware({ namespace: 'brand-test' })(control, () => {
    downstream = true;
    return Promise.resolve();
  });
  expect(downstream).toBe(false);
  expect(control.response.snapshot().status).toBe(401);
});

it('records the key source and whether a key is required in the brand', () => {
  const cases = [
    [
      undefined,
      { idempotent: true, keyHeader: 'Idempotency-Key', required: true, principalRequired: true },
    ],
    [
      { key: { header: 'X-Request-Key' } },
      { idempotent: true, keyHeader: 'X-Request-Key', required: true, principalRequired: true },
    ],
    [
      { key: { header: 'X-Request-Key' }, required: false, principal: 'optional' },
      { idempotent: true, keyHeader: 'X-Request-Key', required: false, principalRequired: false },
    ],
    [
      { key: { bodyField: 'requestId' } },
      { idempotent: true, required: true, principalRequired: true },
    ],
    [
      { key: () => 'k', required: false, principal: 'optional' },
      { idempotent: true, required: false, principalRequired: false },
    ],
    [
      { key: () => 'k', principal: 'required' },
      { idempotent: true, required: true, principalRequired: true },
    ],
  ] as const;
  for (const [options, expected] of cases) {
    expect(idempotencyMetadataOf(idempotent(options))).toEqual(expected);
  }
});
