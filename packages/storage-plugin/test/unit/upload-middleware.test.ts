// deno-lint-ignore-file no-explicit-any
/**
 * Tests for {@linkcode createUploadMiddleware} and {@linkcode getUploadedFile}.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequestContext } from '@hono-enterprise/common';
import { createUploadMiddleware, getUploadedFile } from '../../src/middleware/upload-middleware.ts';
/** Creates a minimal fake context for middleware testing. */
function makeCtx(partial?: Partial<IRequestContext>): IRequestContext {
  const calls: Array<{ status: number; body: unknown }> = [];
  const response: any = {
    status(code: number) {
      this._lastStatus = code;
      return this;
    },
    _lastStatus: 200,
    json(body: unknown) {
      calls.push({ status: this._lastStatus, body });
      return {} as import('@hono-enterprise/common').HandlerResult;
    },
    send() {
      return {} as import('@hono-enterprise/common').HandlerResult;
    },
    header() {
      return this;
    },
  };
  return {
    id: 'test-1',
    request: {
      method: 'POST',
      url: 'http://localhost/upload',
      path: '/upload',
      headers: new Headers(),
      bytes(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array());
      },
    } as unknown as {
      method: string;
      url: string;
      path: string;
      headers: Headers;
      bytes: () => Promise<Uint8Array>;
    },
    response,
    services: {
      has: () => false,
      get: () => null,
      register: () => {},
    } as any,
    params: {},
    query: {},
    state: new Map<string, unknown>(),
    startTime: performance.now(),
    signal: new AbortController().signal,
    ...partial,
  } as unknown as IRequestContext;
}
describe('createUploadMiddleware', () => {
  it('passes through non-multipart requests', async () => {
    const mw = createUploadMiddleware();
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', 'application/json');
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
  });
  it('empty body passes through without storing uploads', async () => {
    const boundary = 'b';
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(new Uint8Array());
    const mw = createUploadMiddleware();
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
    const uploads = ctx.state.get('storage-plugin:uploads') as
      | import('../../src/interfaces/index.ts').UploadedFile[]
      | undefined;
    expect(uploads).toBeUndefined();
  });
  it('stores parsed file in ctx.state', async () => {
    const boundary = '----TestBoundary99';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="test.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('hello multipart'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(body);
    const mw = createUploadMiddleware();
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
    const uploads = ctx.state.get(
      'storage-plugin:uploads',
    ) as import('../../src/interfaces/index.ts').UploadedFile[];
    expect(uploads).toBeDefined();
    expect(uploads.length).toBe(1);
    expect(uploads[0].name).toBe('file');
    expect(uploads[0].mimeType).toBe('text/plain');
    expect(new TextDecoder().decode(uploads[0].data)).toBe('hello multipart');
  });
  it('oversize file returns 400 without calling next', async () => {
    const boundary = '----TestBoundary99';
    const largeData = new Uint8Array(20 * 1024 * 1024); // 20 MB
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="big.bin"\r\n'),
      ...encoder.encode('Content-Type: application/octet-stream\r\n\r\n'),
      ...largeData,
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(body);
    const mw = createUploadMiddleware({ maxSize: 10 * 1024 * 1024 }); // 10 MB limit
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(false);
  });
  it('maxFiles rejection returns 400 without calling next', async () => {
    const boundary = '----MaxFilesBoundary';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="a.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('aaa'),
      ...encoder.encode('\r\n--' + boundary + '\r\n'),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="b.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('bbb'),
      ...encoder.encode('\r\n--' + boundary + '\r\n'),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="c.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('ccc'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(body);
    const mw = createUploadMiddleware({ maxFiles: 2 });
    let nextCalled = false;
    const result = await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(false);
    expect(result).toBeDefined();
  });
  it('missing field returns undefined from helper', () => {
    const ctx = makeCtx();
    // No upload performed — state is empty.
    const result = getUploadedFile(ctx, 'nonexistent');
    expect(result).toBeUndefined();
  });
  it('allowedMimeTypes rejection short-circuits', async () => {
    const boundary = '----TestBoundary99';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="bad.exe"\r\n'),
      ...encoder.encode('Content-Type: application/x-executable\r\n\r\n'),
      ...encoder.encode('pe.exe'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(body);
    const mw = createUploadMiddleware({ allowedMimeTypes: ['text/plain'] });
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(false);
  });
  it('custom fieldname option filters by different field name', async () => {
    const boundary = '----CustomFieldBoundary';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="avatar"; filename="pic.png"\r\n'),
      ...encoder.encode('Content-Type: image/png\r\n\r\n'),
      ...encoder.encode('PNGDATA'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(body);
    const mw = createUploadMiddleware({ fieldname: 'avatar' });
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
    const uploads = ctx.state.get(
      'storage-plugin:uploads',
    ) as import('../../src/interfaces/index.ts').UploadedFile[];
    expect(uploads).toBeDefined();
    expect(uploads.length).toBe(1);
    expect(uploads[0].name).toBe('avatar');
    expect(uploads[0].mimeType).toBe('image/png');
  });
  it('malformed content-type (no boundary) returns 400', async () => {
    const ctx = makeCtx();
    // Content-type includes multipart/form-data but has no boundary parameter
    ctx.request.headers.set('content-type', 'multipart/form-data');
    ctx.request.bytes = () => Promise.resolve(new Uint8Array([0x01, 0x02, 0x03]));
    const mw = createUploadMiddleware();
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(false);
  });
  it('multiple files stored correctly', async () => {
    const boundary = '----MultiFileBoundary';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="f1.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('first'),
      ...encoder.encode('\r\n--' + boundary + '\r\n'),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="f2.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('second'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(body);
    const mw = createUploadMiddleware();
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
    const uploads = ctx.state.get(
      'storage-plugin:uploads',
    ) as import('../../src/interfaces/index.ts').UploadedFile[];
    expect(uploads!.length).toBe(2);
    expect(new TextDecoder().decode(uploads![0].data)).toBe('first');
    expect(new TextDecoder().decode(uploads![1].data)).toBe('second');
  });
  it('default fieldname=file works', async () => {
    const boundary = '----DefaultFieldBoundary';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="default.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('default content'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const ctx = makeCtx();
    ctx.request.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
    ctx.request.bytes = () => Promise.resolve(body);
    const mw = createUploadMiddleware();
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(true);
    const uploads = ctx.state.get(
      'storage-plugin:uploads',
    ) as import('../../src/interfaces/index.ts').UploadedFile[];
    expect(uploads).toBeDefined();
    expect(uploads.length).toBe(1);
    expect(uploads[0].name).toBe('file');
  });

  it('A2: oversized body rejected (400) before parsing via Content-Length header', async () => {
    const ctx = makeCtx();
    const response = ctx.response as unknown as {
      _lastStatus: number;
      constructor: { name: string };
    };
    ctx.request.headers.set(
      'content-type',
      `multipart/form-data; boundary=${response.constructor.name ?? 'b'}`,
    );
    ctx.request.bytes = () => Promise.resolve(new Uint8Array([1, 2, 3]));
    ctx.request.headers.set('content-length', '60000000');
    const mw = createUploadMiddleware({ maxSize: 10 * 1024 * 1024 });
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(false);
    expect(response._lastStatus).toBe(400);
  });

  it('A2: oversized body rejected (400) even without Content-Length (buffer cap)', async () => {
    const ctx = makeCtx();
    const response = ctx.response as unknown as { _lastStatus: number };
    ctx.request.headers.set('content-type', 'multipart/form-data; boundary=b');
    // Send a body larger than the 50 MB hard cap — use 51 MB.
    const bigBody = new Uint8Array(51 * 1024 * 1024);
    bigBody.fill(65);
    ctx.request.bytes = () => Promise.resolve(bigBody);
    const mw = createUploadMiddleware({ maxSize: 10 * 1024 * 1024 });
    let nextCalled = false;
    await mw(ctx, (): Promise<void> => {
      nextCalled = true;
      return Promise.resolve();
    });
    expect(nextCalled).toBe(false);
    expect(response._lastStatus).toBe(400);
  });
});
describe('getUploadedFile', () => {
  it('returns the matching uploaded file', () => {
    const ctx = makeCtx();
    const file: import('../../src/interfaces/index.ts').UploadedFile = {
      name: 'file',
      data: new Uint8Array([88]),
      mimeType: 'text/plain',
      size: 1,
    };
    ctx.state.set('storage-plugin:uploads', [file]);
    const result = getUploadedFile(ctx, 'file');
    expect(result).toEqual(file);
  });
  it('returns undefined when no uploads exist', () => {
    const ctx = makeCtx();
    expect(getUploadedFile(ctx, 'any')).toBeUndefined();
  });
  it('returns undefined when upload has different name (default fieldname)', () => {
    const ctx = makeCtx();
    const file: import('../../src/interfaces/index.ts').UploadedFile = {
      name: 'other',
      data: new Uint8Array([88]),
      mimeType: 'text/plain',
      size: 1,
    };
    ctx.state.set('storage-plugin:uploads', [file]);
    const result = getUploadedFile(ctx); // defaults to 'file'
    expect(result).toBeUndefined();
  });
  it('returns the first matching file using default fieldname', () => {
    const ctx = makeCtx();
    const files: import('../../src/interfaces/index.ts').UploadedFile[] = [
      {
        name: 'file',
        data: new Uint8Array([1]),
        mimeType: 'text/plain',
        size: 1,
      },
      {
        name: 'file',
        data: new Uint8Array([2]),
        mimeType: 'text/plain',
        size: 1,
      },
    ];
    ctx.state.set('storage-plugin:uploads', files);
    const result = getUploadedFile(ctx); // default fieldname='file'
    expect(result).toEqual(files[0]);
  });
  it('returns undefined for empty uploads array', () => {
    const ctx = makeCtx();
    ctx.state.set('storage-plugin:uploads', []);
    expect(getUploadedFile(ctx, 'any')).toBeUndefined();
  });
});
