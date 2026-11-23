import { createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';

const runtime = createBunRuntimeServices();
const server = process.argv[2]!;
const dns = runtime.createDnsResolver!({ servers: [server], timeoutMs: 150 });
process.stdout.write(`${JSON.stringify({ addresses: await dns.resolveHost('ok.test') })}\n`);
const began = runtime.hrtime();
try {
  await dns.resolveSrv('hang.test');
  process.stdout.write(`${JSON.stringify({ unexpected: 'answered silent name' })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ code: (error as { code?: string }).code, elapsedMs: runtime.hrtime() - began })}\n`,
  );
}
