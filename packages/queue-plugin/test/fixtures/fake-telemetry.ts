import { vi } from 'vitest';
import type { ISpan, ITelemetryService, SpanOptions } from '@setu-ts/common';

export const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
export function fakeTelemetry(valid = true): {
  service: ITelemetryService;
  spans: ReturnType<typeof vi.fn>;
} {
  const spans = vi.fn();
  return {
    spans,
    service: {
      withSpan: <T>(
        name: string,
        fn: (span: ISpan) => Promise<T>,
        options?: SpanOptions,
      ): Promise<T> => {
        spans(name, options);
        return fn({
          spanContext: () => ({
            traceId: valid ? '0af7651916cd43dd8448eb211c80319c' : '',
            spanId: valid ? 'b7ad6b7169203331' : '',
            traceFlags: '01',
          }),
        } as ISpan);
      },
    },
  };
}
