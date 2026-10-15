/** Build the single executable and exercise its real HTTP listener. */
import { fileURLToPath } from 'node:url';
import { run } from '../../scripts/lib/run.ts';
import { freePort, startHost } from '../smoke-helpers.ts';

const built = await run('pnpm', ['run', 'build:sea'], { inherit: true });
if (built.code !== 0) throw new Error('Node SEA build failed.');
const port = await freePort();
const server = startHost(
  fileURLToPath(new URL('../../.tmp/compiled-binary/server', import.meta.url)),
  [String(port)],
);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (!response.ok || ((await response.json()) as { status: string }).status !== 'ok') {
        throw new Error('The SEA did not serve GET /health.');
      }
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!ready) throw new Error('The SEA did not start within five seconds.');
} finally {
  server.kill();
  await server.status;
}
