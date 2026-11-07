import { createApp } from './setu.config.ts';
import { issueDemoToken } from './src/auth/demo-token.ts';

// Prints a five-minute demo credential for Swagger UI's Authorize button. The
// app starts without listening, so it can run beside `npm start`.
const app = createApp();
await app.start();
try {
  process.stdout.write(`${await issueDemoToken(app)}\n`);
} finally {
  await app.stop();
}
