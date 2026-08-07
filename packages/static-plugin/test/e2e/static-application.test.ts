import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '../../src/index.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('StaticPlugin e2e', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApplication>;

  beforeEach(async () => {
    tmpDir = join('/tmp', `static-plugin-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, 'test.txt'), 'hello world');
    await writeFile(join(tmpDir, 'index.html'), '<html></html>');

    app = createApplication({
      plugins: [RuntimePlugin(), StaticPlugin({ root: tmpDir })],
    });
  });

  afterEach(async () => {
    await app.stop().catch(() => {});
    // Clean up temp dir
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should serve a large file via streaming', async () => {
    // Create a file larger than 1MB
    const largeContent = 'x'.repeat(1_048_577);
    await writeFile(join(tmpDir, 'large.txt'), largeContent);

    await app.start({ port: 0 });

    const response = await app.fetch(new Request('http://localhost/large.txt'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('1048577');

    const body = await response.text();
    expect(body).toBe(largeContent);
  });

  it('should handle Range requests on large files', async () => {
    const largeContent = 'x'.repeat(1_048_577);
    await writeFile(join(tmpDir, 'large.txt'), largeContent);

    await app.start({ port: 0 });

    const response = await app.fetch(
      new Request('http://localhost/large.txt', {
        headers: { Range: 'bytes=0-99' },
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-99/1048577');

    const body = await response.text();
    expect(body).toBe('x'.repeat(100));
  });

  it('should handle HEAD requests', async () => {
    await app.start({ port: 0 });

    const response = await app.fetch(
      new Request('http://localhost/test.txt', { method: 'HEAD' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe('11');

    const body = await response.text();
    expect(body).toBe('');
  });

  it('should return 416 for unsatisfiable range', async () => {
    await app.start({ port: 0 });

    const response = await app.fetch(
      new Request('http://localhost/test.txt', {
        headers: { Range: 'bytes=1000-2000' },
      }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toContain('*/11');
  });
});
