import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createTraceContextInterceptor } from '../../src/trace/trace-context-interceptor.ts';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SPAN_ID = '0123456789abcdef';

describe('createTraceContextInterceptor', () => {
  it('reads the active span per call and sets a valid traceparent', async () => {
    let spanId = SPAN_ID;
    const interceptor = createTraceContextInterceptor({
      activeSpanContext: () => ({ traceId: TRACE_ID, spanId, traceFlags: '01' }),
    });
    const first = { url: new URL('https://example.test'), headers: new Headers() };
    await interceptor(first);
    expect(first.headers.get('traceparent')).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);

    spanId = 'fedcba9876543210';
    const second = { url: new URL('https://example.test'), headers: new Headers() };
    await interceptor(second);
    expect(second.headers.get('traceparent')).toBe(`00-${TRACE_ID}-${spanId}-01`);
  });

  it('preserves a caller header', async () => {
    const interceptor = createTraceContextInterceptor({
      activeSpanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: '01' }),
    });
    const ctx = {
      url: new URL('https://example.test'),
      headers: new Headers({ traceparent: 'caller' }),
    };
    await interceptor(ctx);
    expect(ctx.headers.get('traceparent')).toBe('caller');
  });

  it('omits absent, malformed, and all-zero contexts', async () => {
    const values = [
      undefined,
      { traceId: 'bad', spanId: SPAN_ID, traceFlags: '01' },
      { traceId: '0'.repeat(32), spanId: SPAN_ID, traceFlags: '01' },
      { traceId: TRACE_ID, spanId: '0'.repeat(16), traceFlags: '01' },
      { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 'XX' },
    ];
    for (const value of values) {
      const interceptor = createTraceContextInterceptor({ activeSpanContext: () => value });
      const ctx = { url: new URL('https://example.test'), headers: new Headers() };
      await interceptor(ctx);
      expect(ctx.headers.has('traceparent')).toBe(false);
    }
  });
});
