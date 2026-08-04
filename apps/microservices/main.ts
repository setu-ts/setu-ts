// deno-lint-ignore-file no-console -- interactive example entry point.
import {
  brokeredGreeting,
  callServiceB,
  createServiceA,
  createServiceB,
  registerGreetingResponder,
} from './src/app.ts';

const serviceAPort = Number(Deno.args[0] ?? 3000);
const serviceBPort = Number(Deno.args[1] ?? 3001);
const redisUrl = Deno.env.get('REDIS_URL');
const serviceB = createServiceB(redisUrl);
const serviceA = createServiceA(serviceBPort, redisUrl);
await serviceB.start({ port: serviceBPort });
await serviceA.start({ port: serviceAPort });
let unsubscribe: (() => Promise<void>) | undefined;
try {
  console.log(await callServiceB(serviceA));
  if (redisUrl === undefined) {
    console.log('Set REDIS_URL to demonstrate brokered request/reply between services.');
  } else {
    unsubscribe = await registerGreetingResponder(serviceB);
    console.log(await brokeredGreeting(serviceA));
  }
} finally {
  if (unsubscribe !== undefined) {
    await unsubscribe();
  }
  await Promise.all([serviceA.stop(), serviceB.stop()]);
}
