import * as nodeFs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { createCommandRunner } from '../../src/utils/run-command.ts';
import { npmInstall, npmRun, runIn, startOverlay } from '../fixtures/node-project.ts';

it(
  'boots a full-stack scaffold, invokes its generated handlers, and refuses a real page collision',
  { timeout: 900_000 },
  async () => {
    const root = await tempDir({ prefix: 'full-stack-wiring-' });
    const runtime = createNodeRuntimeServices();
    const output: string[] = [];
    const cli = (args: readonly string[]) =>
      runCli(args, {
        fs: runtime.fs!,
        cwd: root,
        now: () => runtime.now(),
        log: (line) => output.push(line),
        error: (line) => output.push(line),
        runCommand: createCommandRunner(),
      });
    const overlay = await startOverlay();
    try {
      expect(
        await cli([
          'new',
          'shop',
          '--template',
          'full-stack',
          '--runtime',
          'node',
          '--logger',
          'console',
        ]),
        output.join('\n'),
      ).toBe(0);
      const project = `${root}/shop`;
      for (const plugin of ['events', 'cqrs', 'queue'])
        expect(await cli(['add', plugin, '--dir', project]), output.join('\n')).toBe(0);
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      for (const [schematic, name] of [
        ['event-handler', 'order-placed'],
        ['command-handler', 'place-order'],
        ['query-handler', 'get-order'],
        ['job', 'send-email'],
      ]) {
        expect(await cli(['g', schematic!, name!, '--dir', project]), output.join('\n')).toBe(0);
      }
      expect(await cli(['check', '--dir', project]), output.join('\n')).toBe(0);
      expect(await cli(['g', 'route', 'products', '--dir', project]), output.join('\n')).toBe(1);
      expect(output.join('\n')).toContain('app/routes/_app/products._index.tsx');
      await expect(
        nodeFs.stat(`${project}/src/controllers/products.controller.ts`),
      ).rejects.toThrow();
      // Developer edits stay in artifact modules. Barrels and configuration remain CLI-authored.
      for (const [path, before, after] of [
        [
          'src/events/order-placed.event-handler.ts',
          'export class OrderPlacedEventHandler',
          'export const received: string[] = [];\nexport class OrderPlacedEventHandler',
        ],
        [
          'src/events/order-placed.event-handler.ts',
          'await Promise.resolve(event.data.id);',
          'received.push(event.data.id);',
        ],
        [
          'src/jobs/send-email.job.ts',
          'export function createSendEmailJobProcessor',
          'export const processed: string[] = [];\nexport function createSendEmailJobProcessor',
        ],
        [
          'src/jobs/send-email.job.ts',
          'await Promise.resolve(job.data.id);',
          'processed.push(job.data.id);',
        ],
      ]) {
        const file = `${project}/${path}`;
        const source = await nodeFs.readFile(file, 'utf8');
        expect(source).toContain(before);
        await nodeFs.writeFile(file, source.replace(before!, after!));
      }
      const built = await npmRun(project, 'build');
      expect(built.code, built.output).toBe(0);
      const probe = `import { createApp } from './setu.config.ts';
import { CAPABILITIES, type ICqrsFacade, type IEventBus, type IQueue } from '@setu-ts/common';
import { PLACE_ORDER_COMMAND } from './src/cqrs/place-order.command-handler.ts';
import { GET_ORDER_QUERY } from './src/cqrs/get-order.query-handler.ts';
import { ORDER_PLACED_EVENT, received } from './src/events/order-placed.event-handler.ts';
import { SEND_EMAIL_JOB, processed } from './src/jobs/send-email.job.ts';
const app = await createApp();
try {
  await app.start();
  const cqrs = app.services.get<ICqrsFacade>(CAPABILITIES.CQRS);
  const command = await cqrs.commandBus.execute<{ id: string }>({ type: PLACE_ORDER_COMMAND, data: { id: 'command-proof' } });
  if (command.id !== 'command-proof') throw new Error('command handler did not run');
  const query = await cqrs.queryBus.execute<{ id: string }>({ type: GET_ORDER_QUERY, data: { id: 'query-proof' } });
  if (query.id !== 'query-proof') throw new Error('query handler did not run');
  await app.services.get<IEventBus>(CAPABILITIES.EVENTS).publish({ id: 'event-proof', type: ORDER_PLACED_EVENT, occurredOn: new Date(), data: { id: 'event-proof' } });
  await app.services.get<IQueue>(CAPABILITIES.QUEUE).add(SEND_EMAIL_JOB, { id: 'job-proof' });
  for (let i = 0; i < 200 && processed.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  if (received[0] !== 'event-proof' || processed[0] !== 'job-proof') throw new Error('event/job handler did not run');
  const response = await app.fetch(new Request('http://localhost/'));
  const html = await response.text();
  if (response.status !== 200 || !html.includes('<html')) throw new Error('SSR did not boot');
  console.log('FULL_STACK_WIRING_READBACK=' + JSON.stringify({ command, query, received, processed, page: response.status }));
} finally { await app.stop(); }
`;
      await nodeFs.writeFile(`${project}/wiring-probe.ts`, probe);
      const typed = await runIn(project, 'npx', ['--no-install', 'tsc', '--noEmit']);
      expect(typed.code, typed.output).toBe(0);
      const result = await runIn(project, 'node', ['--import', 'tsx', 'wiring-probe.ts']);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('FULL_STACK_WIRING_READBACK=');
      console.log(result.output);
    } finally {
      await overlay.close();
      await nodeFs.rm(root, { recursive: true, force: true });
    }
  },
);
