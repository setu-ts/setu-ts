// deno-lint-ignore-file no-console -- a skipped prerequisite must be visible in CI.
import {
  brokeredGreeting,
  callServiceB,
  createServiceA,
  createServiceB,
  registerGreetingResponder,
} from './src/app.ts';

function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (!('port' in address)) throw new Error('Expected a TCP listener.');
  return address.port;
}

const serviceBPort = unusedPort();
const redisUrl = Deno.env.get('REDIS_URL');
const serviceB = createServiceB(redisUrl);
const serviceA = createServiceA(serviceBPort, redisUrl);
await serviceB.start({ port: serviceBPort });
await serviceA.start();
let unsubscribe: (() => Promise<void>) | undefined;
try {
  if (await callServiceB(serviceA) !== 'Hello, service-a!') {
    throw new Error("Service A did not receive Service B's network response.");
  }
  if (redisUrl === undefined) {
    console.warn('SKIP: set REDIS_URL to run the cross-service Redis request/reply smoke check.');
    Deno.exitCode = 77;
  } else {
    unsubscribe = await registerGreetingResponder(serviceB);
    if (await brokeredGreeting(serviceA) !== 'Hello, service-a!') {
      throw new Error('Service B did not complete Redis request/reply for service A.');
    }
  }
} finally {
  if (unsubscribe !== undefined) {
    await unsubscribe();
  }
  await Promise.all([serviceA.stop(), serviceB.stop()]);
}
