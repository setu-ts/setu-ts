/* eslint-disable no-console -- a skipped prerequisite must be visible in CI. */
import { freePort } from '../smoke-helpers.ts';
import {
  brokeredGreeting,
  callServiceB,
  createServiceA,
  createServiceB,
  registerGreetingResponder,
} from './src/app.ts';

const serviceBPort = await freePort();
const redisUrl = process.env['REDIS_URL'];
const serviceB = createServiceB(redisUrl);
const serviceA = createServiceA(serviceBPort, redisUrl);
await serviceB.start({ port: serviceBPort });
await serviceA.start();
let unsubscribe: (() => Promise<void>) | undefined;
try {
  if ((await callServiceB(serviceA)) !== 'Hello, service-a!') {
    throw new Error("Service A did not receive Service B's network response.");
  }
  if (redisUrl === undefined) {
    console.warn('SKIP: set REDIS_URL to run the cross-service Redis request/reply smoke check.');
    process.exitCode = 77;
  } else {
    unsubscribe = await registerGreetingResponder(serviceB);
    if ((await brokeredGreeting(serviceA)) !== 'Hello, service-a!') {
      throw new Error('Service B did not complete Redis request/reply for service A.');
    }
  }
} finally {
  if (unsubscribe !== undefined) {
    await unsubscribe();
  }
  await Promise.all([serviceA.stop(), serviceB.stop()]);
}
