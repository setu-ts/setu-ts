import { callServiceB, createServiceA } from './src/app.ts';

const app = createServiceA();
await app.start();
try {
  if (await callServiceB(app) !== 'Hello, service-a!') {
    throw new Error("Service A did not receive Service B's brokered reply.");
  }
} finally {
  await app.stop();
}
