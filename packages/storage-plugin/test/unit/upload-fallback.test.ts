/**
 * The fallback branch (M94b §3.5): a request that OMITS the optional
 * `formData` accessor — the shape an out-of-repo `IRequest` implementor
 * produces — yields uploads identical to the accessor arm, because both arms
 * call the same shared `parseFormBody`. It is not a second implementation.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseFormBody } from '@setu-ts/common';
import type { FormBody, IRequest, IRequestContext } from '@setu-ts/common';
import { createUploadMiddleware, getUploadedFile } from '../../src/index.ts';
import type { UploadedFile } from '../../src/interfaces/index.ts';

const BOUNDARY = 'fb94';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const BODY = new TextEncoder().encode(
  `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
    'Content-Type: text/plain\r\n\r\n' +
    'DATA\r\n' +
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="note"\r\n\r\n' +
    'hello\r\n' +
    `--${BOUNDARY}--\r\n`,
);

/** A minimal context whose request carries ONLY the pre-M94b surface. */
function makeCtx(withAccessor: boolean): IRequestContext {
  const request: IRequest & {
    formData?: () => Promise<FormBody>;
  } = {
    method: 'POST',
    url: 'http://localhost/upload',
    path: '/upload',
    headers: new Headers({ 'content-type': CONTENT_TYPE }),
    bytes: (): Promise<Uint8Array> => Promise.resolve(BODY),
    json: (): Promise<unknown> => Promise.resolve({}),
    text: (): Promise<string> => Promise.resolve(''),
  } as IRequest;
  if (withAccessor) {
    request.formData = (): Promise<FormBody> => Promise.resolve(parseFormBody(BODY, CONTENT_TYPE));
  }

  let status = 0;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    header() {
      return response;
    },
    json(body: unknown) {
      responses.push({ status, body });
      return { __handlerResult: true } as const;
    },
    send() {
      return { __handlerResult: true } as const;
    },
    appendHeader() {
      return response;
    },
    text() {
      return { __handlerResult: true } as const;
    },
  };
  const responses: Array<{ status: number; body: unknown }> = [];

  return {
    id: 'fallback-test',
    request,
    response,
    services: {
      has: () => false,
      get: () => {
        throw new Error('no services in this test');
      },
      register: () => {},
    },
    params: {},
    query: {},
    state: new Map<string, unknown>(),
    startTime: 0,
    signal: new AbortController().signal,
  } as unknown as IRequestContext & { responses: typeof responses };
}

async function run(ctx: IRequestContext): Promise<boolean> {
  const middleware = createUploadMiddleware();
  let nextCalled = false;
  await middleware(ctx, () => {
    nextCalled = true;
    return Promise.resolve();
  });
  return nextCalled;
}

describe('upload fallback — a request without the formData accessor (M94b §3.5)', () => {
  it('delivers uploads identical to the accessor arm', async () => {
    const viaAccessor = makeCtx(true);
    const viaFallback = makeCtx(false);

    expect(await run(viaAccessor)).toBe(true);
    expect(await run(viaFallback)).toBe(true);

    const read = (ctx: IRequestContext): UploadedFile | undefined => getUploadedFile(ctx);
    const accessorFile = read(viaAccessor);
    const fallbackFile = read(viaFallback);

    expect(fallbackFile).toBeDefined();
    expect(accessorFile).toBeDefined();
    expect(fallbackFile).toEqual(accessorFile);
    expect(fallbackFile?.name).toBe('file');
    expect(fallbackFile?.filename).toBe('a.txt');
    expect(fallbackFile?.mimeType).toBe('text/plain');
    expect(fallbackFile?.size).toBe(4);
    expect(new TextDecoder().decode(fallbackFile?.data ?? new Uint8Array(0))).toBe('DATA');
  });

  it('both arms keep a plain (no-filename) value under another field name out of the uploads', async () => {
    const viaAccessor = makeCtx(true);
    const viaFallback = makeCtx(false);
    await run(viaAccessor);
    await run(viaFallback);
    // Only the `file` part was an upload; `note` never was, in either arm.
    expect(getUploadedFile(viaAccessor, 'note')).toBeUndefined();
    expect(getUploadedFile(viaFallback, 'note')).toBeUndefined();
  });
});
