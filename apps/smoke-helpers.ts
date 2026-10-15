/** Node host utilities shared by example smoke checks. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

/** Bind an ephemeral loopback port, then release it for the example server. */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Start a host without detaching it; attach its exit/error listener before it can terminate. */
export function startHost(command: string, args: readonly string[], env = process.env) {
  const child = spawn(command, [...args], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const status = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  // Keep an early startup error observable when the caller awaits status in its finally block.
  void status.catch(() => {});
  return { kill: (signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal), status };
}

/** Node/tsx arguments that preserve the caller's source redirect for a child example. */
export const SOURCE_HOST_ARGS = [
  '--import',
  'tsx',
  '--import',
  new URL('../scripts/lib/source-register.ts', import.meta.url).href,
] as const;
