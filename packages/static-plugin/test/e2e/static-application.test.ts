import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '../../src/index.ts';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

describe('StaticPlugin e2e', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApplication>;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `static-plugin-test-${randomUUID()}`);
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

  it('should return 404 for prefix-adjacent paths', async () => {
    await app.start({ port: 0 });

    const response = await app.fetch(
      new Request('http://localhost/testtxt'),
    );
    expect(response.status).toBe(404);
  });

  it('should serve files through symlink-contained paths', async () => {
    const linkDir = join(tmpDir, 'links');
    await mkdir(linkDir, { recursive: true });
    // Create a symlink to the root
    await symlink(tmpDir, join(linkDir, 'root-link'));

    await app.start({ port: 0 });

    // Request through the symlink should be contained
    const response = await app.fetch(
      new Request('http://localhost/test.txt'),
    );
    expect(response.status).toBe(200);

    await app.stop();
  });

  it('should reject symlink escape attempts', async () => {
    const linkDir = join(tmpDir, 'links');
    await mkdir(linkDir, { recursive: true });
    // Create a symlink pointing outside the root
    const outsideDir = join(tmpdir(), `static-outside-${randomUUID()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'secret.txt'), 'secret');
    await symlink(outsideDir, join(linkDir, 'outside-link'));

    const appWithSymlink = createApplication({
      plugins: [
        RuntimePlugin(),
        StaticPlugin({ root: linkDir }),
      ],
    });

    await appWithSymlink.start({ port: 0 });

    // Try to access the symlinked directory
    const response = await appWithSymlink.fetch(
      new Request('http://localhost/outside-link/secret.txt'),
    );
    // Should be 404 due to containment check
    expect(response.status).toBe(404);

    await appWithSymlink.stop();
    const { rm } = await import('node:fs/promises');
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });
});
