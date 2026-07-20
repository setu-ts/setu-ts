// deno-lint-ignore-file require-await
/**
 * Tests for the common telemetry service contract types.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ISpan,
  ITelemetryService,
  SpanAttributeValue,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
} from '@hono-enterprise/common';

describe('telemetry contract types', () => {
  it('should compile SpanStatus as the documented union', () => {
    const ok: SpanStatus = 'ok';
    const error: SpanStatus = 'error';
    const unset: SpanStatus = 'unset';
    expect(ok).toBe('ok');
    expect(error).toBe('error');
    expect(unset).toBe('unset');
  });

  it('should compile SpanKind as the documented union', () => {
    const internal: SpanKind = 'internal';
    const server: SpanKind = 'server';
    const client: SpanKind = 'client';
    const producer: SpanKind = 'producer';
    const consumer: SpanKind = 'consumer';
    expect(internal).toBe('internal');
    expect(server).toBe('server');
    expect(client).toBe('client');
    expect(producer).toBe('producer');
    expect(consumer).toBe('consumer');
  });

  it('should compile SpanAttributeValue as the documented union', () => {
    const str: SpanAttributeValue = 'hello';
    const num: SpanAttributeValue = 42;
    const bool: SpanAttributeValue = true;
    const arr: SpanAttributeValue = ['a', 1, true];
    expect(str).toBe('hello');
    expect(num).toBe(42);
    expect(bool).toBe(true);
    expect(arr).toEqual(['a', 1, true]);
  });

  it('should compile SpanOptions with optional fields', () => {
    const opts: SpanOptions = {
      kind: 'server',
      attributes: { key: 'value' },
    };
    expect(opts.kind).toBe('server');
    expect(opts.attributes).toBeDefined();
  });

  it('should accept a fake ITelemetryService satisfying the interface', () => {
    class FakeSpan implements ISpan {
      setAttribute(_key: string, _value: SpanAttributeValue): this {
        return this;
      }
      setAttributes(_attrs: Readonly<Record<string, SpanAttributeValue>>): this {
        return this;
      }
      setStatus(_status: SpanStatus): void {/* no-op */}
      recordException(_error: Error): void {/* no-op */}
      end(): void {/* no-op */}
      spanContext() {
        return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: '01' };
      }
    }

    const fakeService: ITelemetryService = {
      async withSpan<T>(
        _name: string,
        fn: (span: ISpan) => Promise<T>,
        _options?: SpanOptions,
      ): Promise<T> {
        const fakeSpan = new FakeSpan();
        return fn(fakeSpan);
      },
    };

    expect(fakeService).toBeDefined();
    expect(typeof fakeService.withSpan).toBe('function');
  });

  it('should accept a fake ISpan satisfying the interface', () => {
    class TestSpan implements ISpan {
      setAttribute(_key: string, _value: SpanAttributeValue): this {
        return this;
      }
      setAttributes(_attrs: Readonly<Record<string, SpanAttributeValue>>): this {
        return this;
      }
      setStatus(_status: SpanStatus): void {/* no-op */}
      recordException(_error: Error): void {/* no-op */}
      end(): void {/* no-op */}
      spanContext() {
        return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: '01' };
      }
    }

    const fakeSpan = new TestSpan();
    expect(fakeSpan).toBeDefined();
    expect(fakeSpan.setAttribute('key', 'val')).toBe(fakeSpan);
  });

  it('should compile TelemetryContext as an opaque interface', () => {
    // TelemetryContext is intentionally opaque — we just verify it compiles.
    const _ctx: TelemetryContext = { _opaque: Symbol.for('test') } as TelemetryContext;
    expect(_ctx).toBeDefined();
  });
});
