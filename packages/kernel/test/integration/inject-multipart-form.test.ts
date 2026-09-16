/**
 * The `v0.6.0` claim as a gate: `inject()` is one of the three producers of
 * `IRequest.formData?()`, and a multipart body is bytes — so a developer
 * testing an upload route writes exactly this shape. Before M95c §3.9 the
 * bytes were JSON-stringified into a `{"0":…}` object, the form parse saw a
 * non-form body, and the route answered an EMPTY form.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';

import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const encoder = new TextEncoder();
const BOUNDARY = '----m95c-inject-multipart';

/** Builds the multipart body exactly as a browser upload would. */
function multipartBody(): Uint8Array {
  const fileBytes = encoder.encode('PNG-DATA-BYTES');
  const segments = [
    `--${BOUNDARY}\r\n`,
    'Content-Disposition: form-data; name="note"\r\n\r\n',
    'hello\r\n',
    `--${BOUNDARY}\r\n`,
    'Content-Disposition: form-data; name="doc"; filename="a.png"\r\n',
    'Content-Type: image/png\r\n\r\n',
  ];
  const head = encoder.encode(segments.join(''));
  const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);

  const out = new Uint8Array(head.length + fileBytes.length + tail.length);
  out.set(head, 0);
  out.set(fileBytes, head.length);
  out.set(tail, head.length + fileBytes.length);
  return out;
}

async function buildApp(): Promise<ReturnType<typeof createApplication>> {
  const runtime: IPlugin = {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
    },
  };

  const app = createApplication({ plugins: [runtime] });

  app.router.post('/upload', async (ctx) => {
    if (ctx.request.formData === undefined) {
      throw new Error('the inject()-built request must carry the formData accessor');
    }
    const form = await ctx.request.formData();
    const file = form.getAll('doc').find((value) => typeof value !== 'string');
    return ctx.response.json({
      note: form.get('note'),
      file: file === undefined ? null : {
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.data.length,
        head: new TextDecoder().decode(file.data.slice(0, 8)),
      },
    });
  });

  // Plugins register during start(); without it the registry is empty. No
  // port → no socket binds.
  await app.start();

  return app;
}

describe('inject() carries a multipart body to formData()', () => {
  it('delivers the field and the file a developer sent as bytes', async () => {
    const app = await buildApp();
    const body = multipartBody();

    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body,
    });

    expect(res.statusCode).toBe(200);
    const parsed = res.json<{
      note: string | null;
      file: { filename: string; mimeType: string; size: number; head: string } | null;
    }>();
    // The field survives intact — the old path turned the WHOLE body into a
    // JSON string, so `note` was null and the file list was empty.
    expect(parsed.note).toBe('hello');
    expect(parsed.file).not.toBe(null);
    expect(parsed.file?.filename).toBe('a.png');
    expect(parsed.file?.mimeType).toBe('image/png');
    expect(parsed.file?.size).toBe(encoder.encode('PNG-DATA-BYTES').length);
    expect(parsed.file?.head).toBe('PNG-DATA');
  });
});
