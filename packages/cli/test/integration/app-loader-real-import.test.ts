import { tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
/**
 * Drives the DEFAULT app loader — a real import through `tsx` — so the
 * production path is exercised, not only the injected test seam.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { configModuleExists, loadApp } from '../../src/app-loader.ts';

const fs: IFileSystem = createNodeRuntimeServices().fs!;

/** A config module that returns a minimal object satisfying the app shape. */
const VALID = `export function createApp() {
  return {
    services: { getAll: () => [] },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}
`;

const ASYNC = `export async function createApp() {
  await Promise.resolve();
  return {
    services: { getAll: () => [] },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}
`;

const NO_EXPORT = `export const somethingElse = 1;\n`;

const THROWS = `export function createApp() {
  throw new Error('missing DATABASE_URL');
}
`;

const WRONG_SHAPE = `export function createApp() {
  return { nope: true };
}
`;

describe('app loader — real import()', () => {
  let root: string;

  beforeAll(async () => {
    root = await tempDir({ prefix: 'setu-app-' });
    await nodeFs.writeFile(`${root}/setu.config.ts`, VALID);
    await nodeFs.mkdir(`${root}/variants`, { recursive: true });
    await nodeFs.writeFile(`${root}/variants/async.ts`, ASYNC);
    await nodeFs.writeFile(`${root}/variants/no-export.ts`, NO_EXPORT);
    await nodeFs.writeFile(`${root}/variants/throws.ts`, THROWS);
    await nodeFs.writeFile(`${root}/variants/wrong-shape.ts`, WRONG_SHAPE);
  });

  afterAll(async () => {
    await nodeFs.rm(root, { recursive: true });
  });

  it('detects the config module on a real filesystem', async () => {
    expect(await configModuleExists(fs, root)).toBe(true);
    expect(await configModuleExists(fs, `${root}/variants`)).toBe(false);
  });

  it('imports a real module from disk through the default loader', async () => {
    // No loader argument: this goes through the real `await import()`.
    const app = await loadApp(root);
    expect(typeof app.start).toBe('function');
    expect(typeof app.stop).toBe('function');
  });

  it('imports a real async factory', async () => {
    const app = await loadApp(root, 'variants/async.ts');
    expect(typeof app.services.getAll).toBe('function');
  });

  it('throws for a real file exporting no createApp', async () => {
    await expect(loadApp(root, 'variants/no-export.ts')).rejects.toThrow(
      "must export a 'createApp' function",
    );
  });

  it('throws naming the factory when it really throws', async () => {
    await expect(loadApp(root, 'variants/throws.ts')).rejects.toThrow('missing DATABASE_URL');
  });

  it('throws when a real factory returns the wrong shape', async () => {
    await expect(loadApp(root, 'variants/wrong-shape.ts')).rejects.toThrow(
      'must return the application from createApplication()',
    );
  });

  it('throws for a module that does not exist on disk', async () => {
    await expect(loadApp(root, 'variants/absent.ts')).rejects.toThrow('Cannot load');
  });

  // M111d §3.3: Node's own type stripping rejects a decorator, so a class-based
  // project's config only loads through tsx; and the project's tsconfig is the
  // one nearest the module, so its path alias resolves however the CLI was
  // invoked. A loader reading the repository's tsconfig would miss `~/`.
  it('loads a decorated config that imports through its own tsconfig path alias', async () => {
    const project = await tempDir({ prefix: 'setu-app-ts-' });
    await nodeFs.mkdir(`${project}/src`, { recursive: true });
    await nodeFs.writeFile(
      `${project}/tsconfig.json`,
      JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
    );
    await nodeFs.writeFile(
      `${project}/src/marker.ts`,
      `export function marked(_value: unknown, context: ClassDecoratorContext): void {
  (context.metadata as Record<string, unknown>).marked = true;
}
`,
    );
    await nodeFs.writeFile(
      `${project}/setu.config.ts`,
      `import { marked } from '~/marker.ts';

@marked
class Holder {}

export function createApp() {
  const metadata = (Holder as unknown as Record<symbol, Record<string, unknown> | undefined>)[
    Symbol.for('Symbol.metadata')
  ];
  return {
    services: { getAll: () => [metadata?.marked === true ? 'decorated' : 'plain'] },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}
`,
    );
    const app = await loadApp(project);
    expect(app.services.getAll('anything')).toEqual(['decorated']);
  });
});
