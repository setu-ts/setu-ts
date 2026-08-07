import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { StaticFilesService } from '../../src/services/static-files-service.ts';

describe('StaticFilesService', () => {
  it('should create service with default options', () => {
    const service = new StaticFilesService({ root: '/tmp/static' });
    expect(service).toBeDefined();
  });

  it('should create service with custom options', () => {
    const service = new StaticFilesService({
      root: '/tmp/static',
      urlPrefix: '/assets',
      index: 'index.html',
      etag: false,
      ranges: true,
      compressed: false,
    });
    expect(service).toBeDefined();
  });
});
