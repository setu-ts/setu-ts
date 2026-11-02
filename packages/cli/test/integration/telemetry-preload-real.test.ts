/**
 * The generated OpenTelemetry preload makes a lazily imported driver traceable
 * (M131a X88-4). A guarded REAL test: it needs the ioredis instrumentation,
 * OpenTelemetry's loader hook and ioredis installed in the workspace, and is
 * skipped when any is absent.
 *
 * A child Node process runs a project laid out like a generated one: the real
 * `instrumentation.mjs` this CLI writes, `--import`ed ahead of an ES module
 * that enables the ioredis instrumentation and then imports `ioredis` lazily,
 * as every Redis-backed plugin does. With the preload, ioredis is patched and a
 * command records a span; without it (the negative control), neither. The child
 * is needed because Vitest does not load modules through Node's ESM loader.
 *
 * @module
 */
import { execFile } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_PRELOAD_CONTENTS,
  TELEMETRY_PRELOAD_FLAG,
  TELEMETRY_PRELOAD_PATH,
} from '../../src/templates/telemetry-preload.ts';

const run = promisify(execFile);
const packages = fileURLToPath(new URL('../../../', import.meta.url));

/** Each package the child imports by bare name, and the directory it lives in. */
function resolvePackages(): Record<string, string> | undefined {
  try {
    const telemetry = createRequire(nodePath.join(packages, 'telemetry-plugin/package.json'));
    const queue = createRequire(nodePath.join(packages, 'queue-plugin/package.json'));
    const instrumentationEntry = telemetry.resolve('@opentelemetry/instrumentation-ioredis');
    const fromInstrumentation = createRequire(instrumentationEntry);
    const dirOf = (entry: string, name: string): string =>
      entry.slice(0, entry.lastIndexOf(`/node_modules/${name}/`) + `/node_modules/${name}`.length);
    return {
      '@opentelemetry/instrumentation-ioredis': dirOf(
        instrumentationEntry,
        '@opentelemetry/instrumentation-ioredis',
      ),
      '@opentelemetry/instrumentation': dirOf(
        fromInstrumentation.resolve('@opentelemetry/instrumentation'),
        '@opentelemetry/instrumentation',
      ),
      '@opentelemetry/sdk-trace-base': dirOf(
        telemetry.resolve('@opentelemetry/sdk-trace-base'),
        '@opentelemetry/sdk-trace-base',
      ),
      ioredis: dirOf(queue.resolve('ioredis'), 'ioredis'),
    };
  } catch {
    return undefined;
  }
}

/** The application: enable the instrumentation, then import ioredis lazily. */
const MAIN = `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sdk = require('@opentelemetry/sdk-trace-base');
const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
const exporter = new sdk.InMemorySpanExporter();
const provider = new sdk.BasicTracerProvider({
  spanProcessors: [new sdk.SimpleSpanProcessor(exporter)],
});
const instrumentation = new IORedisInstrumentation({ requireParentSpan: false });
instrumentation.setTracerProvider(provider);
instrumentation.enable();
const { default: Redis } = await import('ioredis');
const client = new Redis({
  port: 1,
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
await client.get('m131a').catch(() => {});
client.disconnect();
console.log(JSON.stringify({
  wrapped: Boolean(Redis.prototype.sendCommand.__wrapped),
  spans: exporter.getFinishedSpans().map((span) => span.name),
}));
`;

const resolved = resolvePackages();

describe('REAL: the generated preload instruments a lazily imported ioredis', () => {
  it(
    'patches ioredis with the preload and not without it',
    { skip: resolved === undefined },
    async () => {
      const dir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'setu-preload-real-'));
      try {
        for (const [name, target] of Object.entries(resolved!)) {
          const link = nodePath.join(dir, 'node_modules', name);
          await nodeFs.mkdir(nodePath.dirname(link), { recursive: true });
          await nodeFs.symlink(target, link, 'dir');
        }
        await nodeFs.writeFile(nodePath.join(dir, 'package.json'), '{ "type": "module" }\n');
        await nodeFs.writeFile(
          nodePath.join(dir, TELEMETRY_PRELOAD_PATH),
          TELEMETRY_PRELOAD_CONTENTS,
        );
        await nodeFs.writeFile(nodePath.join(dir, 'main.mjs'), MAIN);
        const start = async (flags: readonly string[]) => {
          const { stdout } = await run(process.execPath, [...flags, 'main.mjs'], { cwd: dir });
          return JSON.parse(stdout.trim()) as { wrapped: boolean; spans: string[] };
        };
        const withPreload = await start(TELEMETRY_PRELOAD_FLAG.split(' '));
        expect(withPreload.wrapped).toBe(true);
        expect(withPreload.spans).toContain('get');
        const without = await start([]);
        expect(without.wrapped).toBe(false);
        expect(without.spans).toEqual([]);
      } finally {
        await nodeFs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
