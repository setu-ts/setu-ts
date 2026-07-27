/**
 * Unit tests for the plugin detection utility.
 *
 * @module
 */

import { detectPlugins } from '../../src/utils/plugin-detector.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('detectPlugins', () => {
  it('reads deno.json and extracts plugin names from imports', async () => {
    const mockFs = {
      readFile:  (_path: string) => {
        return new TextEncoder().encode(
          '{ "imports": { "@hono-enterprise/auth-plugin": "./plugins/auth", "@hono-enterprise/cache-plugin": "./plugins/cache" } }',
        );
      },
      stat:  ( _path: string) => ({ isFile: true, isDirectory: false, size: 0 }),
    };

    const result = await detectPlugins(mockFs as unknown);
    expect(result.has('auth-plugin')).toBe(true);
    expect(result.has('cache-plugin')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('reads package.json and extracts plugin names from dependencies', async () => {
    const mockFs = {
      readFile: (path: string) => {
        if (path.includes('deno.json')) {
          throw new Error('Not found');
        }
        return new TextEncoder().encode(
          '{ "dependencies": { "@hono-enterprise/auth-plugin": "^1.0.0", "@hono-enterprise/cache-plugin": "^1.0.0" } }',
        );
      },
      stat:  ( _path: string) => ({ isFile: true, isDirectory: false, size: 0 }),
    };

    const result = await detectPlugins(mockFs as unknown);
    expect(result.has('auth-plugin')).toBe(true);
    expect(result.has('cache-plugin')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('returns empty set when neither manifest exists', async () => {
    const mockFs = {
      readFile:  (_path: string) => {
        throw new Error('Not found');
      },
      stat:  ( _path: string) => ({ isFile: true, isDirectory: false, size: 0 }),
    };

    const result = await detectPlugins(mockFs as unknown);
    expect(result.size).toBe(0);
  });

  it('handles malformed JSON by returning empty set', async () => {
    const mockFs = {
      readFile:  (_path: string) => {
        return new TextEncoder().encode('{ invalid json');
      },
      stat:  ( _path: string) => ({ isFile: true, isDirectory: false, size: 0 }),
    };

    const result = await detectPlugins(mockFs as unknown);
    expect(result.size).toBe(0);
  });
});
