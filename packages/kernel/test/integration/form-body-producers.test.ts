/**
 * The M94b cross-producer contract (the X37-1 shape): ONE form parse in
 * `common`, so the same urlencoded body and the same multipart body produce
 * IDENTICAL `get`/`getAll`/`entries` output through all three `IRequest`
 * producers — the kernel's `inject()`, a real served request mapped by
 * `@setu-ts/runtime`'s HTTP adapter into a `FrameworkRequest`, and
 * `@setu-ts/testing`'s `MockRequest`. This is the test that makes "one
 * implementation" checkable rather than asserted.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestContext } from '@setu-ts/testing';
import type {
  FormBody,
  HandlerResult,
  IPluginContext,
  IRequest,
  IRequestContext,
} from '@setu-ts/common';

const URLENCODED = 'application/x-www-form-urlencoded';
const MULTIPART_CT = 'multipart/form-data; boundary=fb94';
const URLENCODED_BODY = 'tag=one&note=&tag=two';
const MULTIPART_BODY = [
  '--fb94\r\n',
  'Content-Disposition: form-data; name="tag"\r\n\r\n',
  'one\r\n',
  '--fb94\r\n',
  'Content-Disposition: form-data; name="file"; filename="a.txt"\r\n',
  'Content-Type: text/plain\r\n\r\n',
  'DATA\r\n',
  '--fb94\r\n',
  'Content-Disposition: form-data; name="tag"\r\n\r\n',
  'two\r\n',
  '--fb94--\r\n',
].join('');
const DATA_BYTES = Array.from(new TextEncoder().encode('DATA'));

/** The one expected answer, in both encodings, all three producers must give. */
const EXPECTED_URLENCODED = {
  getTag: 'one',
  getAllTag: ['one', 'two'],
  getMissing: undefined,
  file: [] as unknown[],
  entries: [['tag', 'one'], ['note', ''], ['tag', 'two']],
};
const EXPECTED_MULTIPART = {
  getTag: 'one',
  getAllTag: ['one', 'two'],
  getMissing: undefined,
  file: [{ filename: 'a.txt', mimeType: 'text/plain', bytes: DATA_BYTES }],
  entries: [['tag', 'one'], ['file', DATA_BYTES], ['tag', 'two']],
};

/** Normalizes a `FormBody` to a JSON-able snapshot the three compare by. */
function snapshot(form: FormBody): unknown {
  return {
    getTag: form.get('tag'),
    getAllTag: form.getAll('tag'),
    getMissing: form.get('missing'),
    file: form.getAll('file').map((value) =>
      typeof value === 'string'
        ? { text: value }
        : { filename: value.filename, mimeType: value.mimeType, bytes: Array.from(value.data) }
    ),
    entries: Array.from(form.entries()).map(([name, value]) => [
      name,
      typeof value === 'string' ? value : Array.from(value.data),
    ]),
  };
}

/**
 * Reads the form off a producer's request. All three producers ALWAYS provide
 * the accessor; the guard keeps the optional member's type honest at the call
 * site without a non-null assertion.
 */
function readForm(request: IRequest): Promise<FormBody> {
  const read = request.formData;
  if (read === undefined) {
    return Promise.reject(new Error('this producer must provide formData()'));
  }
  return read.call(request);
}

function boot(): ReturnType<typeof createApplication> {
  const app = createApplication({
    plugins: [
      // Real runtime plugin: it supplies the `runtime` capability AND the
      // HTTP adapter, so the served arm flows through the real mapping into
      // a real `FrameworkRequest`.
      RuntimePlugin(),
      {
        name: 'form-routes',
        version: '1.0.0',
        register(ctx: IPluginContext) {
          ctx.router.post('/echo-form', {
            handler: async (c: IRequestContext): Promise<HandlerResult> => {
              return c.response.json(snapshot(await readForm(c.request)));
            },
          });
          ctx.router.post('/same-ref', {
            handler: async (c: IRequestContext): Promise<HandlerResult> => {
              const [a, b] = await Promise.all([readForm(c.request), readForm(c.request)]);
              return c.response.json({ same: Object.is(a, b) });
            },
          });
        },
      },
    ],
  });
  return app;
}

interface ProducerResult {
  readonly viaInject: unknown;
  readonly viaServed: unknown;
  readonly viaMock: unknown;
}

/** Drives the same body through all three producers. */
async function producerResults(contentType: string, body: string): Promise<ProducerResult> {
  const app = boot();
  await app.start();
  try {
    const injected = await app.inject({
      method: 'POST',
      url: 'http://localhost/echo-form',
      headers: { 'content-type': contentType },
      body,
    });

    const served = await app.fetch(
      new Request('http://localhost/echo-form', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      }),
    );

    const mocked = createTestContext({ body });
    mocked.request.headers.set('content-type', contentType);

    return {
      viaInject: injected.json(),
      viaServed: await served.json(),
      viaMock: snapshot(await readForm(mocked.request)),
    };
  } finally {
    await app.stop();
  }
}

describe('one form parse, three producers (M94b §3.6)', () => {
  it('urlencoded: inject(), a served request, and MockRequest agree', async () => {
    const { viaInject, viaServed, viaMock } = await producerResults(URLENCODED, URLENCODED_BODY);
    expect(viaInject).toEqual(EXPECTED_URLENCODED);
    expect(viaServed).toEqual(EXPECTED_URLENCODED);
    expect(viaMock).toEqual(EXPECTED_URLENCODED);
  });

  it('multipart: the same three producers agree, file part included', async () => {
    const { viaInject, viaServed, viaMock } = await producerResults(MULTIPART_CT, MULTIPART_BODY);
    expect(viaInject).toEqual(EXPECTED_MULTIPART);
    expect(viaServed).toEqual(EXPECTED_MULTIPART);
    expect(viaMock).toEqual(EXPECTED_MULTIPART);
  });

  it('every producer memoizes: concurrent formData() calls return the same reference', async () => {
    const app = boot();
    await app.start();
    try {
      const injected = await app.inject({
        method: 'POST',
        url: 'http://localhost/same-ref',
        headers: { 'content-type': URLENCODED },
        body: URLENCODED_BODY,
      });
      expect(injected.json()).toEqual({ same: true });

      const served = await app.fetch(
        new Request('http://localhost/same-ref', {
          method: 'POST',
          headers: { 'content-type': URLENCODED },
          body: URLENCODED_BODY,
        }),
      );
      expect(await served.json()).toEqual({ same: true });

      const mocked = createTestContext({ body: URLENCODED_BODY });
      mocked.request.headers.set('content-type', URLENCODED);
      const [mockA, mockB] = await Promise.all([
        readForm(mocked.request),
        readForm(mocked.request),
      ]);
      expect(Object.is(mockA, mockB)).toBe(true);
    } finally {
      await app.stop();
    }
  });
});
