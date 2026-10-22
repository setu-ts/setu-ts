/* eslint-disable no-console -- an example entry reports what it did. */
import { greetOverBroker, greetOverHttp } from './src/service-a/greeting.client.ts';
import { createServiceA } from './src/service-a/service-a.config.ts';
import { respondToGreetings } from './src/service-b/greeting.responder.ts';
import { createServiceB } from './src/service-b/service-b.config.ts';

const serviceAPort = Number(process.argv[2] ?? 3000);
const serviceBPort = Number(process.argv[3] ?? 3001);
const redisUrl = process.env['REDIS_URL'];

const serviceB = createServiceB(redisUrl);
const serviceA = createServiceA(serviceBPort, redisUrl);
await serviceB.start({ port: serviceBPort });
await serviceA.start({ port: serviceAPort });

try {
  console.log(await greetOverHttp(serviceA.services));
  if (redisUrl === undefined) {
    console.log('Set REDIS_URL to demonstrate brokered request/reply between services.');
  } else {
    const responder = await respondToGreetings(serviceB.services);
    try {
      console.log(await greetOverBroker(serviceA.services));
    } finally {
      await responder.unsubscribe();
    }
  }
} finally {
  await Promise.all([serviceA.stop(), serviceB.stop()]);
}
