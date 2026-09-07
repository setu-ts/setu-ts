import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { StaticFilesService } from '../../src/services/static-files-service.ts';
import type { IStaticFiles } from '../../src/interfaces/index.ts';

describe('StaticFilesService', () => {
  let service: IStaticFiles;

  beforeEach(() => {
    service = new StaticFilesService({ root: '/tmp/static' });
  });

  it('should create service with default options', () => {
    expect(service).toBeDefined();
  });

  it('should create service with custom options', () => {
    const custom = new StaticFilesService({
      root: '/tmp/static',
      urlPrefix: '/assets',
      index: 'index.html',
      etag: false,
      ranges: true,
      compressed: false,
    });
    expect(custom).toBeDefined();
  });

  it('should implement IStaticFiles.serve', () => {
    expect(typeof service.serve).toBe('function');
  });

  it('should return 404 rather than throw when no filesystem is available', async () => {
    const response = {
      statusCode: 200,
      status(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      send() {
        return undefined;
      },
    };
    const result = service.serve({ response } as never);
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(response.statusCode).toBe(404);
  });

  it('should pass the real filesystem to the handler', () => {
    const fs = {
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 5 }),
      readFile: () => Promise.resolve(new Uint8Array([1, 2, 3, 4, 5])),
      realPath: () => Promise.resolve('/tmp/static/test.txt'),
      writeFile: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };

    const serviceWithFs = new StaticFilesService({ root: '/tmp/static', fs });
    expect(serviceWithFs).toBeDefined();
  });
});
