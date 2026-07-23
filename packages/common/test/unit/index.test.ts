// deno-lint-ignore-file require-await
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, none, ok, PLUGIN_PRIORITY, some } from '../../src/index.ts';
import type {
  IScheduler,
  RetryOptions,
  ScheduledJob,
  ScheduleOptions,
  SchedulerBackoff,
  SchedulerJobHandler,
} from '../../src/index.ts';
import type {
  ISpan,
  ITelemetryService,
  SpanAttributeValue,
  SpanKind,
  SpanOptions,
  SpanStatus,
} from '../../src/index.ts';
import type {
  BackoffStrategy,
  BulkheadPolicy,
  CircuitBreakerPolicy,
  CircuitState,
  ICircuitBreaker,
  IResilienceService,
  RetryPolicy,
  WrapOptions,
} from '../../src/index.ts';

describe('@hono-enterprise/common barrel', () => {
  it('should export the capability token constants', () => {
    expect(CAPABILITIES.LOGGER).toBe('logger');
    expect(PLUGIN_PRIORITY.NORMAL).toBe(500);
  });

  it('should export the utility constructors', () => {
    expect(ok(1).success).toBe(true);
    expect(some(1).present).toBe(true);
    expect(none().present).toBe(false);
  });

  it('should export scheduler types', () => {
    // Compile-time verification that scheduler types resolve from barrel
    const _scheduler: IScheduler = {} as IScheduler;
    const _job: ScheduledJob<string> = { id: '', name: '', data: '', attempts: 0 };
    const _handler: SchedulerJobHandler<string> = () => {};
    const _options: ScheduleOptions<string> = {};
    const _retry: RetryOptions = { limit: 1, delay: 100, backoff: 'fixed' };
    const _backoff: SchedulerBackoff = 'fixed';
    expect(_scheduler).toBeDefined();
    expect(_job).toBeDefined();
    expect(_handler).toBeDefined();
    expect(_options).toBeDefined();
    expect(_retry).toBeDefined();
    expect(_backoff).toBe('fixed');
  });

  it('should have SCHEDULER capability token', () => {
    expect(CAPABILITIES.SCHEDULER).toBe('scheduler');
  });

  it('should export telemetry types', () => {
    // Compile-time verification that telemetry types resolve from barrel
    const _status: SpanStatus = 'ok';
    const _kind: SpanKind = 'internal';
    const _attr: SpanAttributeValue = 'value';
    const _opts: SpanOptions = { kind: 'server' };
    const _span: ISpan = {
      setAttribute: () => _span,
      setAttributes: () => _span,
      setStatus: () => {},
      recordException: () => {},
      end: () => {},
      spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: '01' }),
    };
    const _fakeSpan: ISpan = {
      setAttribute: () => _fakeSpan,
      setAttributes: () => _fakeSpan,
      setStatus: () => {},
      recordException: () => {},
      end: () => {},
      spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: '01' }),
    };
    const _service: ITelemetryService = {
      withSpan: async <T>(_name: string, fn: (span: ISpan) => Promise<T>): Promise<T> =>
        fn(_fakeSpan),
    };
    expect(_status).toBe('ok');
    expect(_kind).toBe('internal');
    expect(_attr).toBe('value');
    expect(_opts.kind).toBe('server');
    expect(_span).toBeDefined();
    expect(_service).toBeDefined();
  });

  it('should export resilience types and the RESILIENCE token', () => {
    // Compile-time verification that resilience types resolve from the barrel.
    const _backoff: BackoffStrategy = 'exponential';
    const _cb: CircuitBreakerPolicy = { threshold: 5, timeout: 1000, resetTimeout: 5000 };
    const _retry: RetryPolicy = { limit: 3, delay: 100, backoff: 'fixed' };
    const _bulkhead: BulkheadPolicy = { maxConcurrent: 10 };
    const _opts: WrapOptions = { circuitBreaker: true, retry: _retry, timeout: 2000 };
    const _service: IResilienceService = {
      wrap: <T>(fn: () => Promise<T>): () => Promise<T> => fn,
    };
    const _state: CircuitState = 'half-open';
    const _breaker: ICircuitBreaker = {
      state: _state,
      execute: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    };
    expect(_backoff).toBe('exponential');
    expect(_cb.threshold).toBe(5);
    expect(_retry.limit).toBe(3);
    expect(_bulkhead.maxConcurrent).toBe(10);
    expect(_opts.timeout).toBe(2000);
    expect(_service).toBeDefined();
    expect(_breaker.state).toBe('half-open');
    expect(CAPABILITIES.RESILIENCE).toBe('resilience');
  });
});
