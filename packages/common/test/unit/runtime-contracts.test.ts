import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem } from '../../src/runtime.ts';

describe('IFileSystem.readStream is optional', () => {
  it('should satisfy IFileSystem without readStream', () => {
    const fs: IFileSystem = {
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };
    expect(fs).toBeDefined();
    expect(fs.readFile).toBeDefined();
    expect(fs.stat).toBeDefined();
    expect(fs.readStream).toBeUndefined();
  });

  it('should satisfy IFileSystem with readStream', () => {
    const fs: IFileSystem = {
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      readStream: () => Promise.resolve(new ReadableStream()),
    };
    expect(fs).toBeDefined();
    expect(fs.readStream).toBeDefined();
  });
});
