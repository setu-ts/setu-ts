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

  it('should return a Promise from serve', async () => {
    const result = service.serve({} as never);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow();
  });
});
