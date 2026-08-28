import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  contextToTraceparent,
  extractContextFromHeaders,
  parseTraceparentToContext,
  TELEMETRY_CONTEXT_OPAQUE,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from '../../src/index.ts';

describe('W3C trace context codec', () => {
  it('round-trips a valid traceparent', () => {
    const context = parseTraceparentToContext(
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    );
    expect(contextToTraceparent(context)).toBe(
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    );
  });

  it('returns an opaque context for absent, malformed, and unsupported headers', () => {
    expect(parseTraceparentToContext(null)).toEqual({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
    expect(parseTraceparentToContext('broken')).toEqual({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
    expect(parseTraceparentToContext('01-0123456789abcdef0123456789abcdef-0123456789abcdef-01'))
      .toEqual({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
    expect(parseTraceparentToContext('00-00000000000000000000000000000000-0123456789abcdef-01'))
      .toEqual({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
    expect(parseTraceparentToContext('00-0123456789abcdef0123456789abcdef-0000000000000000-01'))
      .toEqual({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
    expect(parseTraceparentToContext('00-ABCDEFABCDEFABCDEFABCDEFABCDEFAB-0123456789abcdef-01'))
      .toEqual({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
  });

  it('extracts tracestate and does not format incomplete contexts', () => {
    const headers = new Headers({
      [TRACEPARENT_HEADER]: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      [TRACESTATE_HEADER]: 'vendor=value',
    });
    expect(extractContextFromHeaders(headers).tracestate).toBe('vendor=value');
    expect(contextToTraceparent({ _opaque: TELEMETRY_CONTEXT_OPAQUE })).toBeNull();
    expect(contextToTraceparent({
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: '00000000000000000000000000000000',
      spanId: '0123456789abcdef',
    })).toBeNull();
    expect(contextToTraceparent({
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB',
      spanId: '0123456789abcdef',
    })).toBeNull();
  });
});
