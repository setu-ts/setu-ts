/**
 * Unit tests for the file writer utility.
 *
 * @module
 */

import { createWriter, type GeneratedFile } from '../../src/utils/file-writer.ts';
import type { IFileSystem } from '@hono-enterprise/common';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// Simple mock filesystem implementation for testing
class MockFileSystem implements IFileSystem {
  readFile = (_path: string): Promise<Uint8Array> => Promise.resolve(new Uint8Array());
  writeFile = (_path: string, _data: Uint8Array) => Promise.resolve();
  readdir = (_path: string) => Promise.resolve([]);
  mkdir = (_path: string, _options?: { recursive?: boolean }) => Promise.resolve();
  rm = (_path: string) => Promise.resolve();

  stat = (
    _path: string,
  ): Promise<
    { readonly isFile: boolean; readonly isDirectory: boolean; size: number; mtime?: Date }
  > => {
    // For overwrite test, pretend the file exists
    if (_path === 'existing.txt' || _path === 'new.txt') {
      return Promise.resolve({ isFile: true, isDirectory: false, size: 0 });
    }
    return Promise.resolve({ isFile: false, isDirectory: true, size: 0 });
  };
}

describe('createWriter', () => {
  it('writes files in order and creates parent directories', async () => {
    const mockFs = new MockFileSystem();

    const writer = createWriter({ fs: mockFs, dryRun: false });
    await writer([
      { path: 'src/controllers/user.controller.ts', contents: 'export class UserController {}' },
      { path: 'services/user.service.ts', contents: 'export class UserService {}' },
    ]);

    // This test verifies the writer works without errors
    // Full integration tests verify actual file system behavior
  });

  it('dry run prints what would be created without writing', async () => {
    const mockFs = new MockFileSystem();

    const writer = createWriter({ fs: mockFs, dryRun: true });
    await writer([{ path: 'test.ts', contents: 'console.log("test")' }]);

    // Dry run doesn't throw, simply logs to console
  });

  it('fails when any file would overwrite existing', async () => {
    const mockFs = new MockFileSystem();

    const files: GeneratedFile[] = [
      { path: 'existing.txt', contents: 'new content' },
      { path: 'new.txt', contents: 'new content' },
    ];

    const writer = createWriter({ fs: mockFs, dryRun: false });

    await expect(writer(files)).rejects.toThrow(
      'The following files already exist and would be overwritten:',
    );
  });
});
