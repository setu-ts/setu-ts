import { brokeredGreeting, callServiceB, createServiceA, createServiceB } from './src/app.ts';

function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (!('port' in address)) throw new Error('Expected a TCP listener.');
  return address.port;
}

const serviceBPort = unusedPort();
const serviceB = createServiceB();
const serviceA = createServiceA(serviceBPort);
await serviceB.start({ port: serviceBPort });
await serviceA.start();
try {
  if (await callServiceB(serviceA) !== 'Hello, service-a!') {
    throw new Error("Service A did not receive Service B's network response.");
  }
  if (await brokeredGreeting(serviceA) !== 'Hello, service-a!') {
    throw new Error('The messaging broker did not complete request/reply.');
  }
} finally {
  await Promise.all([serviceA.stop(), serviceB.stop()]);
}
