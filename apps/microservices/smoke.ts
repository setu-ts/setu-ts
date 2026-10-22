import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { freePort, skipAfterTests } from '../smoke-helpers.ts';
import { greetOverBroker, greetOverHttp } from './src/service-a/greeting.client.ts';
import { createServiceA } from './src/service-a/service-a.config.ts';
import { respondToGreetings } from './src/service-b/greeting.responder.ts';
import { createServiceB } from './src/service-b/service-b.config.ts';

const redisUrl = process.env['REDIS_URL'];

describe('microservices example', () => {
  let serviceA: IKernelApplication;
  let serviceB: IKernelApplication;

  before(async () => {
    const serviceBPort = await freePort();
    serviceB = createServiceB(redisUrl);
    serviceA = createServiceA(serviceBPort, redisUrl);
    await serviceB.start({ port: serviceBPort });
    await serviceA.start();
  });

  after(async () => {
    await Promise.all([serviceA.stop(), serviceB.stop()]);
  });

  it('service A discovers service B and calls it over HTTP', async () => {
    assert.equal(await greetOverHttp(serviceA.services), 'Hello, service-a!');
  });

  it(
    'service B answers service A through the Redis broker',
    { skip: redisUrl === undefined },
    async () => {
      const responder = await respondToGreetings(serviceB.services);
      try {
        assert.equal(await greetOverBroker(serviceA.services), 'Hello, service-a!');
      } finally {
        await responder.unsubscribe();
      }
    },
  );
});

if (redisUrl === undefined) {
  skipAfterTests('set REDIS_URL to run the cross-service Redis request/reply check.');
}
