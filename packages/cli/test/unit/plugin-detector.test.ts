/**
 * Unit tests for the plugin detection utility.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';
import { detectPlugins } from '../../src/utils/plugin-detector.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('detectPlugins', () => {
  it('reads deno.json and extracts plugin names from imports', async () => {
    const mockFs: IFileSystem = {
      readFile: (_path: string) =>
        Promise.resolve(
          new TextEncoder().encode(
            '{ "imports": { "@hono-enterprise/auth-plugin": "./plugins/auth", "@hono-enterprise/cache-plugin": "./plugins/cache" } }',
          ),
        ),
      stat: (_path: string) => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      realPath: (path) => Promise.resolve(path),
      writeFile: () => Promise.resolve(),
    };

    const result = await detectPlugins(mockFs);
    expect(result.has('auth-plugin')).toBe(true);
    expect(result.has('cache-plugin')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('reads package.json and extracts plugin names from dependencies', async () => {
    const mockFs: IFileSystem = {
      readFile: (path: string) => {
        if (path.includes('deno.json')) {
          throw new Error('Not found');
        }
        return Promise.resolve(
          new TextEncoder().encode(
            '{ "dependencies": { "@hono-enterprise/auth-plugin": "^1.0.0", "@hono-enterprise/cache-plugin": "^1.0.0" } }',
          ),
        );
      },
      stat: (_path: string) => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      realPath: (path) => Promise.resolve(path),
      writeFile: () => Promise.resolve(),
    };

    const result = await detectPlugins(mockFs);
    expect(result.has('auth-plugin')).toBe(true);
    expect(result.has('cache-plugin')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('returns empty set when neither manifest exists', async () => {
    const mockFs: IFileSystem = {
      readFile: (_path: string) => Promise.reject(new Error('Not found')),
      stat: (_path: string) => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      realPath: (path) => Promise.resolve(path),
      writeFile: () => Promise.resolve(),
    };

    const result = await detectPlugins(mockFs);
    expect(result.size).toBe(0);
  });

  it('handles malformed JSON by returning empty set', async () => {
    const mockFs: IFileSystem = {
      readFile: (_path: string) =>
        Promise.resolve(new TextEncoder().encode('{ invalid json')) as Promise<Uint8Array>,
      stat: (_path: string) => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      realPath: (path) => Promise.resolve(path),
      writeFile: () => Promise.resolve(),
    };

    const result = await detectPlugins(mockFs);
    expect(result.size).toBe(0);
  });
});
