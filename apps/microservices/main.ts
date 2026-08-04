// deno-lint-ignore-file no-console -- interactive example entry point.
import { brokeredGreeting, callServiceB, createServiceA, createServiceB } from './src/app.ts';

const serviceAPort = Number(Deno.args[0] ?? 3000);
const serviceBPort = Number(Deno.args[1] ?? 3001);
const serviceB = createServiceB();
const serviceA = createServiceA(serviceBPort);
await serviceB.start({ port: serviceBPort });
await serviceA.start({ port: serviceAPort });
try {
  console.log(await callServiceB(serviceA));
  console.log(await brokeredGreeting(serviceA));
} finally {
  await Promise.all([serviceA.stop(), serviceB.stop()]);
}
