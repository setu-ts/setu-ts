const output = await new Deno.Command('deno', {
  args: ['compile', '--allow-net', '--allow-env', '--output', '../../.tmp/hono-example', 'main.ts'],
  stdout: 'inherit',
  stderr: 'inherit',
}).output();
if (!output.success) {
  throw new Error('deno compile did not produce the example binary.');
}

function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (!('port' in address)) throw new Error('Expected a TCP listener.');
  return address.port;
}

const port = unusedPort();
const server = new Deno.Command('.tmp/hono-example', {
  cwd: '../..',
  stdout: 'piped',
  stderr: 'piped',
  args: [String(port)],
}).spawn();
let cleanupError: unknown;
try {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok || (await response.json() as { status: string }).status !== 'ok') {
    throw new Error('The compiled binary did not serve GET /health.');
  }
} finally {
  try {
    server.kill('SIGTERM');
  } catch (error) {
    if (!(error instanceof TypeError) || error.message !== 'Child process has already terminated') {
      cleanupError = error;
    }
  }
  await server.status;
}

if (cleanupError !== undefined) {
  throw cleanupError;
}
