/** End-to-end trace propagation through the SDK and a real kernel handler. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { createClient, createTraceContextInterceptor } from '../../src/index.ts';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SPAN_ID = '0123456789abcdef';

describe('SDK trace propagation', () => {
  it('adds the active traceparent while an unconfigured client sends none', async () => {
    const app = createApplication({ plugins: [RuntimePlugin()] });
    app.router.get(
      '/trace',
      (ctx) => ctx.response.json({ traceparent: ctx.request.headers.get('traceparent') }),
    );
    await app.start();

    const appFetch: typeof fetch = (input, init) => app.fetch(new Request(input, init));
    try {
      const plain = createClient({ baseUrl: 'http://localhost', fetch: appFetch });
      expect(
        (await plain.request<{ traceparent: string | null }>({
          method: 'GET',
          path: 'trace',
        })).data,
      ).toEqual({ traceparent: null });

      const traced = createClient({
        baseUrl: 'http://localhost',
        fetch: appFetch,
        requestInterceptors: [createTraceContextInterceptor({
          activeSpanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: '01' }),
        })],
      });
      expect(
        (await traced.request<{ traceparent: string | null }>({
          method: 'GET',
          path: 'trace',
        })).data,
      ).toEqual({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` });
    } finally {
      await app.stop();
    }
  });
});
