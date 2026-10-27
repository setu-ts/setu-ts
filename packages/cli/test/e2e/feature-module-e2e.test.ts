/** Exercises the generated tasks and feature lifecycle on real installed projects. @module */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import {
  startOverlay,
  npmInstall,
  npmRun,
  runIn,
  withNodeServer,
  type RegistryOverlay,
} from '../fixtures/node-project.ts';
import { useWorkspacePackages, withGeneratedServer } from '../fixtures/generated-project.ts';

const runtime = createNodeRuntimeServices();
let overlay: RegistryOverlay;
beforeAll(async () => {
  overlay = await startOverlay();
}, 900_000);
afterAll(async () => {
  await overlay?.close();
});

// A non-empty repository with real filtering and CRUD replaces the generated store.
// The seed is intentional: a restored "list is []" spec fails after this replacement.
const IMPLEMENTED_SERVICE = `import type { CreateInvoicesBody, UpdateInvoicesBody, ListInvoicesQuery, InvoicesResponse } from './invoices.schemas.ts';
const ledger: InvoicesResponse[] = [{ id: 'opening', name: 'Opening balance' }];
export function listInvoices(query: ListInvoicesQuery = { limit: 20, offset: 0 }): readonly InvoicesResponse[] {
  return ledger.slice(query.offset, query.offset + query.limit);
}
export function getInvoices(id: string): InvoicesResponse | undefined { return ledger.find((row) => row.id === id); }
export function createInvoices(body: CreateInvoicesBody): InvoicesResponse {
  const row = { id: crypto.randomUUID(), name: body.name };
  ledger.push(row);
  return row;
}
export function updateInvoices(id: string, body: UpdateInvoicesBody): InvoicesResponse | undefined {
  const row = getInvoices(id);
  if (row === undefined) return undefined;
  if (body.name !== undefined) row.name = body.name;
  return row;
}
`;

describe('feature module generated tasks', () => {
  for (const target of ['node', 'deno', 'bun'] as const) {
    it(`runs generated feature module contracts on ${target}`, { timeout: 900_000 }, async () => {
      const root = await tempDir({ prefix: `setu-feature-${target}-` });
      const project = `${root}/shop`;
      const run = (args: readonly string[]): Promise<number> =>
        runCli(args, {
          fs: runtime.fs!,
          cwd: root,
          now: () => runtime.now(),
          log: () => {},
          error: () => {},
        });
      try {
        expect(await run(['new', 'shop', '--template', 'rest', '--runtime', target])).toBe(0);
        for (const args of [
          ['module', 'invoices'],
          ['service', 'pricing', '--module', 'invoices'],
          ['route', 'summary', '--module', 'invoices'],
        ]) {
          expect(await run(['generate', ...args, '--dir', project]), args.join(' ')).toBe(0);
        }
        await nodeFs.writeFile(
          `${project}/src/modules/invoices/invoices.service.ts`,
          IMPLEMENTED_SERVICE,
        );
        const originalDenoManifest =
          target === 'deno' ? await nodeFs.readFile(`${project}/deno.json`, 'utf8') : undefined;
        if (target === 'deno') {
          await useWorkspacePackages(project);
          const installed = await runIn(project, 'deno', ['install', '--allow-scripts']);
          expect(installed.code, installed.output).toBe(0);
        } else {
          const installed = await npmInstall(project, overlay);
          expect(installed.code, installed.output).toBe(0);
        }
        for (const task of ['test:e2e', 'test']) {
          // Bun's console reporter may omit passing test names when the logger
          // writes directly to stdout (Pino). Use its machine report to prove
          // which files ran, independently of the chosen logging transport.
          const reportFile = `bun-${task === 'test' ? 'unit' : 'e2e'}-results.xml`;
          const result = await runIn(project, target === 'node' ? 'npm' : target, [
            target === 'deno' ? 'task' : 'run',
            task,
            ...(target === 'bun' ? ['--reporter=junit', '--reporter-outfile', reportFile] : []),
          ]);
          expect(result.code, `${target} ${task}\n${result.output}`).toBe(0);
          const scopeReport =
            target === 'bun'
              ? await nodeFs.readFile(`${project}/${reportFile}`, 'utf8')
              : result.output;
          if (task === 'test')
            expect(scopeReport).not.toMatch(/invoices e2e|invoices\.e2e\.test\.ts/);
          else expect(scopeReport).toMatch(/invoices e2e|invoices\.e2e\.test\.ts/);
        }
        const drive = async (origin: string): Promise<void> => {
          const response = await fetch(`${origin}/openapi.json`);
          expect(response.status).toBe(200);
          const document = (await response.json()) as {
            paths: Record<
              string,
              { post?: { requestBody?: unknown }; get?: { responses?: unknown } }
            >;
            components?: { schemas?: Record<string, unknown> };
          };
          expect(document.paths['/invoices']?.post?.requestBody).toBeDefined();
          expect(document.paths['/invoices']?.get?.responses).toBeDefined();
          expect(Object.keys(document.components?.schemas ?? {}).length).toBeGreaterThan(0);
          const refs = [
            ...JSON.stringify(document.paths['/invoices']).matchAll(
              /"\$ref":"#\/components\/schemas\/([^"]+)"/g,
            ),
          ];
          expect(refs.length).toBeGreaterThan(0);
          for (const ref of refs) expect(document.components?.schemas?.[ref[1]!]).toBeDefined();
          for (const method of ['GET', 'PATCH']) {
            const missing = await fetch(`${origin}/invoices/missing`, {
              method,
              ...(method === 'PATCH'
                ? {
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ name: 'Updated' }),
                  }
                : {}),
            });
            expect(missing.status, method).toBe(404);
            expect(missing.headers.get('content-type'), method).toContain(
              'application/problem+json',
            );
            expect(await missing.json(), method).toMatchObject({
              status: 404,
              title: 'Not Found',
              detail: 'Invoices not found.',
            });
          }
          // A hostile id must not be reflected into the Problem Details body:
          // the detail is fixed, so neither the tag nor its attribute survives.
          const echoed = await fetch(`${origin}/invoices/${encodeURIComponent('"><img src=x>')}`);
          expect(echoed.status).toBe(404);
          expect(echoed.headers.get('content-type')).toContain('application/problem+json');
          const echoedBody = await echoed.text();
          expect(echoedBody).not.toContain('<img');
          expect(echoedBody).not.toContain('src=x');
          expect(JSON.parse(echoedBody)).toMatchObject({
            status: 404,
            title: 'Not Found',
            detail: 'Invoices not found.',
          });
          const summary = await fetch(`${origin}/invoices/summary`);
          expect(summary.status).toBe(200);
          expect(await summary.json()).toEqual({ items: [] });
        };
        if (target === 'deno') await withGeneratedServer(project, drive);
        else {
          if (target === 'node') {
            const built = await npmRun(project, 'build');
            expect(built.code, built.output).toBe(0);
          }
          await withNodeServer(project, drive);
        }
        await nodeFs.rm(`${project}/src/modules/invoices`, { recursive: true });
        // The source redirect adds all framework imports for source resolution;
        // generation must see the installed package set the scaffold declared.
        if (originalDenoManifest !== undefined)
          await nodeFs.writeFile(`${project}/deno.json`, originalDenoManifest);
        expect(await run(['generate', 'module', 'other', '--dir', project])).toBe(0);
        if (target === 'deno') await useWorkspacePackages(project);
        const barrel = await nodeFs.readFile(`${project}/src/modules/index.ts`, 'utf8');
        expect(barrel).not.toContain('invoices');
        expect(barrel).toContain('registerOtherModule');
        const afterDelete = async (origin: string): Promise<void> => {
          const response = await fetch(`${origin}/other`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ items: [] });
          const greeting = await fetch(`${origin}/greetings/Setu`);
          expect(greeting.status).toBe(200);
          expect(await greeting.json()).toEqual({ message: 'Hello, Setu!' });
        };
        if (target === 'deno') await withGeneratedServer(project, afterDelete);
        else {
          if (target === 'node') {
            const built = await npmRun(project, 'build');
            expect(built.code, built.output).toBe(0);
          }
          await withNodeServer(project, afterDelete);
        }
      } finally {
        await nodeFs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
