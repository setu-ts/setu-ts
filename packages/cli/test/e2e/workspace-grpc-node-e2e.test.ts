/** Generated Node members must actually call gRPC over the default HTTP/2 client. @module */
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { runCli } from '../../src/cli.ts';
import { unusedPortRange } from '../fixtures/generated-project.ts';
import { runIn } from '../fixtures/node-project.ts';
import { NODE_SOURCE_ARGS } from '../../../../test/node-helpers.ts';

const describeNode = describe.skipIf(typeof Deno !== 'undefined');
const runtime = createNodeRuntimeServices();
const requirePeer = createRequire(new URL('../../../grpc-plugin/package.json', import.meta.url));
const protobuf = pathToFileURL(requirePeer.resolve('@bufbuild/protobuf')).href;
const wkt = pathToFileURL(requirePeer.resolve('@bufbuild/protobuf/wkt')).href;
const nodeArgs = [...NODE_SOURCE_ARGS, '--conditions', 'development'];
let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined) await fs.rm(directory, { recursive: true, force: true });
});

// A minimal descriptor for the standard health service, decoded by the same Protobuf-ES
// peer as the generated caller. Status 1 is the protocol's SERVING enum value.
const PROBE = `import { create, createFileRegistry } from '${protobuf}';
import { FileDescriptorProtoSchema } from '${wkt}';
import { grpcClient } from '@setu-ts/grpc-plugin';
import { createApp } from './setu.config.ts';
const file = create(FileDescriptorProtoSchema, {
  name: 'health-client.proto', package: 'grpc.health.v1', syntax: 'proto3',
  messageType: [
    { name: 'HealthCheckRequest', field: [{ name: 'service', number: 1, type: 9 }] },
    { name: 'HealthCheckResponse', field: [{ name: 'status', number: 1, type: 14, typeName: '.grpc.health.v1.ServingStatus' }] },
  ],
  enumType: [{ name: 'ServingStatus', value: [{ name: 'UNKNOWN', number: 0 }, { name: 'SERVING', number: 1 }] }],
  service: [{ name: 'Health', method: [{ name: 'Check', inputType: '.grpc.health.v1.HealthCheckRequest', outputType: '.grpc.health.v1.HealthCheckResponse' }] }],
});
const definition = createFileRegistry(file).getService('grpc.health.v1.Health');
if (definition === undefined) throw new Error('missing health descriptor');
const app = await createApp();
await app.start();
try {
  const client = grpcClient(app.services, definition, 'billing');
  const response = await client.check({ service: '' });
  if (response.status !== 1) throw new Error('health did not report SERVING');
  console.log('__GRPC_RESULT__SERVING');
} catch (cause) {
  console.error('__GRPC_FAILURE__' + String(cause));
  process.exitCode = 1;
} finally { await app.stop(); }
`;

describeNode('generated Node workspace gRPC', () => {
  it(
    'calls billing from orders and fails the same call when runtimeOptions returns {}',
    { timeout: 120_000 },
    async () => {
      await fs.mkdir('.tmp', { recursive: true });
      directory = await fs.mkdtemp('.tmp/workspace-grpc-node-');
      const parent = fileURLToPath(new URL(`../../../../${directory}/`, import.meta.url)).replace(
        /\/$/,
        '',
      );
      const root = `${parent}/shop`;
      const base = await unusedPortRange(2);
      const output: string[] = [];
      const cli = (args: readonly string[]) =>
        runCli(args, {
          fs: runtime.fs!,
          cwd: parent,
          now: () => runtime.now(),
          log: (line) => output.push(line),
          error: (line) => output.push(line),
        });
      expect(
        await cli(['new', 'shop', '--workspace', '--runtime', 'node', '--port', String(base)]),
        output.join('\n'),
      ).toBe(0);
      expect(
        await cli([
          'g',
          'app',
          'billing',
          '--template',
          'microservice',
          '--rpc',
          'grpc',
          '--logger',
          'console',
          '--dir',
          root,
        ]),
        output.join('\n'),
      ).toBe(0);
      expect(
        await cli([
          'g',
          'app',
          'orders',
          '--template',
          'microservice',
          '--depends-on',
          'billing',
          '--logger',
          'console',
          '--dir',
          root,
        ]),
        output.join('\n'),
      ).toBe(0);
      await fs.writeFile(`${root}/apps/orders/probe.ts`, PROBE);
      const transport = `${root}/apps/billing/src/transport/index.ts`;
      const original = await fs.readFile(transport, 'utf8');
      expect(original).toContain('return { http2: true };');
      expect(await fs.readFile(`${root}/apps/orders/src/transport/index.ts`, 'utf8')).toContain(
        "billing: { basePath: '/grpc' }",
      );

      const probe = async () => {
        let logs = '';
        const peer = spawn(process.execPath, [...nodeArgs, 'main.ts'], {
          cwd: `${root}/apps/billing`,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        peer.stdout.on('data', (chunk: Buffer) => {
          logs += chunk.toString();
        });
        peer.stderr.on('data', (chunk: Buffer) => {
          logs += chunk.toString();
        });
        const closed = new Promise<void>((resolve) => peer.once('close', () => resolve()));
        try {
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            if (peer.exitCode !== null) throw new Error(logs);
            try {
              const response = await fetch(`http://127.0.0.1:${base}/ready`);
              await response.text();
              if (response.ok) {
                ready = true;
                break;
              }
            } catch {
              /* The peer has not bound yet. */
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(ready, logs).toBe(true);
          return await runIn(`${root}/apps/orders`, process.execPath, [...nodeArgs, 'probe.ts']);
        } finally {
          peer.kill('SIGTERM');
          const timer = setTimeout(() => peer.kill('SIGKILL'), 5000);
          try {
            await closed;
          } finally {
            clearTimeout(timer);
          }
        }
      };

      const good = await probe();
      expect(good.code, good.output).toBe(0);
      expect(good.output).toContain('__GRPC_RESULT__SERVING');
      try {
        await fs.writeFile(transport, original.replace('return { http2: true };', 'return {};'));
        const broken = await probe();
        expect(broken.code).not.toBe(0);
        expect(broken.output).toContain('__GRPC_FAILURE__');
        expect(broken.output).not.toContain('__GRPC_RESULT__SERVING');
        console.log(
          `Negative control runtimeOptions() = {}: exit ${broken.code}\n${broken.output}`,
        );
      } finally {
        await fs.writeFile(transport, original);
      }
      const restored = await probe();
      expect(restored.code, restored.output).toBe(0);
      expect(restored.output).toContain('__GRPC_RESULT__SERVING');
    },
  );
});
