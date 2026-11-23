import { createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';

const runtime = createBunRuntimeServices();
const server = process.argv[2]!;
const silent = process.argv[3]!;
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
// A silent first server: Bun never ends an attempt in under about 1 s, so only the resolver's
// own per-attempt deadline reaches the answering second server inside a 300 ms bound.
const pair = runtime.createDnsResolver!({ servers: [silent, server], timeoutMs: 300 });
const fallbackBegan = runtime.hrtime();
const fallback = await pair.resolveHost('ok.test');
process.stdout.write(
  `${JSON.stringify({ fallback, elapsedMs: runtime.hrtime() - fallbackBegan })}\n`,
);
