/**
 * Drives the DEFAULT app loader — a real dynamic `import()` — so the production
 * path is exercised, not only the injected test seam.
 *
 * @module
 */

import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { configModuleExists, loadApp } from '../../src/app-loader.ts';

const fs: IFileSystem = createDenoRuntimeServices().fs!;

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
    root = await Deno.makeTempDir({ prefix: 'setu-app-' });
    await Deno.writeTextFile(`${root}/setu.config.ts`, VALID);
    await Deno.mkdir(`${root}/variants`, { recursive: true });
    await Deno.writeTextFile(`${root}/variants/async.ts`, ASYNC);
    await Deno.writeTextFile(`${root}/variants/no-export.ts`, NO_EXPORT);
    await Deno.writeTextFile(`${root}/variants/throws.ts`, THROWS);
    await Deno.writeTextFile(`${root}/variants/wrong-shape.ts`, WRONG_SHAPE);
  });

  afterAll(async () => {
    await Deno.remove(root, { recursive: true });
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
    await expect(loadApp(root, 'variants/no-export.ts'))
      .rejects.toThrow("must export a 'createApp' function");
  });

  it('throws naming the factory when it really throws', async () => {
    await expect(loadApp(root, 'variants/throws.ts'))
      .rejects.toThrow('missing DATABASE_URL');
  });

  it('throws when a real factory returns the wrong shape', async () => {
    await expect(loadApp(root, 'variants/wrong-shape.ts'))
      .rejects.toThrow('must return the application from createApplication()');
  });

  it('throws for a module that does not exist on disk', async () => {
    await expect(loadApp(root, 'variants/absent.ts')).rejects.toThrow('Cannot load');
  });
});
