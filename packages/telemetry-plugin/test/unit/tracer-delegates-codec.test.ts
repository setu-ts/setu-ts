import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TELEMETRY_CONTEXT_OPAQUE } from '@setu-ts/common';
import { createNoopTracerHost } from '../../src/plugin/telemetry-plugin.ts';

describe('TracerHost W3C codec delegation', () => {
  it('uses the common codec for extract and inject', () => {
    const host = createNoopTracerHost();
    const context = host.extractContext(
      new Headers({
        traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      }),
    );

    expect(context).toEqual({
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: '01',
    });
    expect(host.injectContext(context)).toEqual({
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    });
  });
});
