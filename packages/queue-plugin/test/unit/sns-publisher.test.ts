import { describe, expect, it, vi } from 'vitest';
import { SnsPublisher } from '../../src/sns/sns-publisher.ts';
import type { ISnsTransport } from '../../src/sns/sns-publisher.ts';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('SnsPublisher', () => {
  it.each([false, true])('bounds and aborts publishJob=%s using runtime timers', async (job) => {
    const runtime = new FakeRuntimeServices(0);
    let signal: AbortSignal | undefined;
    const client: ISnsTransport = {
      publish: (_arn, _body, options) => {
        signal = options?.abortSignal;
        return new Promise(() => {});
      },
      close: async () => {},
    };
    const publisher = new SnsPublisher({
      topicArn: 'topic',
      runtime,
      requestTimeoutMs: 25,
      client,
    });
    await publisher.connect();
    const result = (job ? publisher.publishJob('build', {}) : publisher.publish({})).catch(
      (error: unknown) => error,
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await runtime.advanceMs(25);
    expect(await result).toBeInstanceOf(BackendOutcomeUnknownError);
    expect(signal?.aborted).toBe(true);
    await publisher.disconnect();
  });
  it('supports ambient timers, disabled bounds, and classifies publish faults', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<string>();
    const client = { publish: vi.fn(() => pending.promise), close: async () => {} };
    const bounded = new SnsPublisher({ topicArn: 'topic', requestTimeoutMs: 25, client });
    await bounded.connect();
    const result = bounded.publish({}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toBeInstanceOf(BackendOutcomeUnknownError);
    await bounded.disconnect();
    const unbounded = new SnsPublisher({ topicArn: 'topic', requestTimeoutMs: 0, client });
    await unbounded.connect();
    let settled = false;
    const call = unbounded.publish({}).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(settled).toBe(false);
    pending.resolve('id');
    await call;
    client.publish.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { $metadata: { httpStatusCode: 503 } }),
    );
    await expect(unbounded.publishJob('build', {}, { id: 'j' })).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    await unbounded.disconnect();
    vi.useRealTimers();
  });
  it.each([-1, NaN, Infinity, 2147483648])('refuses requestTimeoutMs %s', (requestTimeoutMs) =>
    expect(() => new SnsPublisher({ topicArn: 'topic', requestTimeoutMs })).toThrow(RangeError),
  );
  describe('connect()', () => {
    it('uses injected client', async () => {
      const transport: ISnsTransport = {
        publish: () => Promise.resolve('msg-id'),
        close: () => Promise.resolve(),
      };
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
        client: transport,
      });

      await publisher.connect();
      expect(publisher.isReady()).toBe(true);
    });
  });

  describe('publish()', () => {
    it('sends string message directly', async () => {
      let publishedBody = '';
      const transport: ISnsTransport = {
        publish: (_t, b) => {
          publishedBody = b;
          return Promise.resolve('msg-id');
        },
        close: () => Promise.resolve(),
      };
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
        client: transport,
      });
      await publisher.connect();

      await publisher.publish('hello');
      expect(publishedBody).toBe('hello');
    });

    it('serializes object message to JSON', async () => {
      let publishedBody = '';
      const transport: ISnsTransport = {
        publish: (_t, b) => {
          publishedBody = b;
          return Promise.resolve('msg-id');
        },
        close: () => Promise.resolve(),
      };
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
        client: transport,
      });
      await publisher.connect();

      await publisher.publish({ event: 'test' });
      expect(publishedBody).toBe('{"event":"test"}');
    });
  });

  describe('disconnect()', () => {
    it('closes the transport', async () => {
      let closed = false;
      const transport: ISnsTransport = {
        publish: () => Promise.resolve('msg-id'),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      };
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
        client: transport,
      });
      await publisher.connect();
      await publisher.disconnect();

      expect(closed).toBe(true);
      expect(publisher.isReady()).toBe(false);
    });
  });

  describe('publish() error paths', () => {
    it('throws when not connected', async () => {
      const transport: ISnsTransport = {
        publish: () => Promise.resolve('msg-id'),
        close: () => Promise.resolve(),
      };
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
        client: transport,
      });

      // Connect then disconnect
      await publisher.connect();
      await publisher.disconnect();

      try {
        await publisher.publish('hello');
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect((err as Error).message).toContain('not connected');
      }
    });
  });

  describe('isReady', () => {
    it('returns false before connect', () => {
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
      });
      expect(publisher.isReady()).toBe(false);
    });

    it('returns true after connect', async () => {
      const transport: ISnsTransport = {
        publish: () => Promise.resolve('msg-id'),
        close: () => Promise.resolve(),
      };
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
        client: transport,
      });

      expect(publisher.isReady()).toBe(false);
      await publisher.connect();
      expect(publisher.isReady()).toBe(true);
    });
  });

  describe('connect idempotent', () => {
    it('allows calling connect twice', async () => {
      const transport: ISnsTransport = {
        publish: () => Promise.resolve('msg-id'),
        close: () => Promise.resolve(),
      };
      const publisher = new SnsPublisher({
        topicArn: 'arn:aws:sns:us-east-1:123456:topic',
        client: transport,
      });

      await publisher.connect();
      await publisher.connect(); // should not throw
      expect(publisher.isReady()).toBe(true);
    });
  });

  describe('adaptSnsModule', () => {
    it('creates transport from SDK module', async () => {
      const { adaptSnsModule } = await import('../../src/sns/sns-publisher.ts');

      // Fake SDK module matching SnsSdkModule shape
      const fakeClient = {
        send: vi.fn(() =>
          Promise.resolve({
            MessageId: 'test-msg-id',
          }),
        ),
        destroy: async () => {},
      };
      const mod = {
        SNSClient: class {
          send = fakeClient.send;
          destroy = fakeClient.destroy;
        },
        PublishCommand: class {
          constructor(public input: Record<string, unknown>) {}
        },
      };

      const transport = adaptSnsModule(
        mod as unknown as import('../../src/sns/sns-publisher.ts').SnsSdkModule,
        { region: 'us-east-1' },
      );

      const options = { abortSignal: new AbortController().signal };
      const msgId = await transport.publish('arn:aws:sns:us-east-1:123456:topic', 'hello', options);
      expect(msgId).toBe('test-msg-id');
      expect(fakeClient.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          input: { TopicArn: 'arn:aws:sns:us-east-1:123456:topic', Message: 'hello' },
        }),
        options,
      );
      await transport.close();
    });

    it('passes credentials and endpoint to client config', async () => {
      const { adaptSnsModule } = await import('../../src/sns/sns-publisher.ts');

      let capturedConfig: Record<string, unknown> = {};
      const fakeClient = {
        send: (_cmd: unknown) =>
          Promise.resolve({
            MessageId: 'msg-2',
          }),
        destroy: async () => {},
      };
      const mod = {
        SNSClient: class {
          constructor(config: Record<string, unknown>) {
            capturedConfig = config;
          }
          send = fakeClient.send;
          destroy = fakeClient.destroy;
        },
        PublishCommand: class {
          constructor(public input: Record<string, unknown>) {}
        },
      };

      adaptSnsModule(mod as unknown as import('../../src/sns/sns-publisher.ts').SnsSdkModule, {
        region: 'eu-west-1',
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
        endpoint: 'http://localstack:4566',
      });

      expect(capturedConfig.region).toBe('eu-west-1');
      expect(capturedConfig.credentials).toEqual({
        accessKeyId: 'key',
        secretAccessKey: 'secret',
      });
      expect(capturedConfig.endpoint).toBe('http://localstack:4566');
    });
  });
});

// Guarded real-import: exercises the lazy-load path through loadSnsModule.
// The SDK module is pinned in deno.lock so the import resolves; connect()
// sets #ready to true. Disconnect afterwards to clean up.
describe('SnsPublisher — lazy SDK load', () => {
  it('connect without an injected client exercises the loadSnsModule() path', async () => {
    const publisher = new SnsPublisher({
      topicArn: 'arn:aws:sns:us-east-1:123456:topic',
    });

    // The SDK module is cached in deno.lock, so connect() resolves (loadSnsModule
    // is exercised) and the publisher becomes ready. Disconnect to clean up.
    await publisher.connect();
    expect(publisher.isReady()).toBe(true);
    await publisher.disconnect();
    expect(publisher.isReady()).toBe(false);
  });
});

// loadSnsModule exported
describe('loadSnsModule (exported)', () => {
  it('is exported as a function', async () => {
    const mod = await import('../../src/sns/sns-publisher.ts');
    expect(typeof mod.loadSnsModule).toBe('function');
  });

  it('the REAL SDK module adapts to a port carrying every member the code calls', async () => {
    const { loadSnsModule, adaptSnsModule } = await import('../../src/sns/sns-publisher.ts');

    // Loads `npm:` for real (pinned in deno.lock), then adapts it. Asserting the
    // adapted PORT rather than just reaching the import line is what catches SDK
    // drift: a renamed constructor throws here, and a member the adapter forgot
    // to build is caught by name. A bare `try { await load() } catch {}` covered
    // the line while asserting nothing and could not fail.
    const mod = await loadSnsModule();
    const port = adaptSnsModule(mod, { region: 'us-east-1' }) as unknown as Record<string, unknown>;

    for (const member of ['publish', 'close']) {
      expect(typeof port[member]).toBe('function');
    }
  });
});

// A2: C4 — class-level lazy SNS config (adaptSnsModule forwards options)
describe('C4: class-level lazy SNS config', () => {
  it('adaptSnsModule forwards region, endpoint, and credentials to SNSClient', async () => {
    const { adaptSnsModule } = await import('../../src/sns/sns-publisher.ts');
    let capturedConfig: Record<string, unknown> | undefined;
    const mod = {
      SNSClient: class {
        constructor(cfg: Record<string, unknown>) {
          capturedConfig = cfg;
        }
        send = () => Promise.resolve({ MessageId: 'msg-id' });
        destroy = () => Promise.resolve();
      },
      PublishCommand: class {},
    };
    adaptSnsModule(mod as unknown as import('../../src/sns/sns-publisher.ts').SnsSdkModule, {
      region: 'eu-west-1',
      credentials: { accessKeyId: 'SNS-KEY', secretAccessKey: 'sns-secret' },
      endpoint: 'http://local-sns:4566',
    });
    expect(capturedConfig).not.toBeUndefined();
    expect(capturedConfig!.region).toBe('eu-west-1');
    expect(capturedConfig!.endpoint).toBe('http://local-sns:4566');
    expect(capturedConfig!.credentials).toEqual({
      accessKeyId: 'SNS-KEY',
      secretAccessKey: 'sns-secret',
    });
  });
});

describe('loadSnsModule — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the SDK is absent', async () => {
    const { loadSnsModule } = await import('../../src/sns/sns-publisher.ts');
    vi.doMock('@aws-sdk/client-sns', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadSnsModule();
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@aws-sdk/client-sns');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@aws-sdk/client-sns');
    }
  });
});

import { fakeTelemetry, TRACEPARENT } from '../fixtures/fake-telemetry.ts';
import { encodeSqsEnvelope, decodeSqsEnvelope } from '../../src/adapters/sqs-envelope.ts';

describe('SNS job publishing', () => {
  for (const telemetry of [undefined, fakeTelemetry().service]) {
    it.each([
      { label: 'NaN attempts', data: {}, maxAttempts: NaN },
      { label: 'undefined data', data: undefined, maxAttempts: 3 },
      { label: 'BigInt data', data: 1n, maxAttempts: 3 },
    ])(
      `rejects $label consistently with telemetry=${telemetry !== undefined}`,
      async ({ data, maxAttempts }) => {
        const publish = vi.fn(() => Promise.resolve('mid'));
        const publisher = new SnsPublisher({
          topicArn: 'topic',
          ...(telemetry === undefined ? {} : { telemetry }),
          client: { publish, close: () => Promise.resolve() },
        });
        await publisher.connect();
        try {
          await expect(
            publisher.publishJob('build', data, { id: 'explicit', maxAttempts }),
          ).rejects.toThrow(TypeError);
          expect(publish).not.toHaveBeenCalled();
        } finally {
          await publisher.disconnect();
        }
      },
    );
  }
  it('uses runtime identity, copies headers and omits an absent attempt budget', async () => {
    const publish = vi.fn(() => Promise.resolve('message-id'));
    const publisher = new SnsPublisher({
      topicArn: 'topic',
      runtime: new FakeRuntimeServices(0),
      client: { publish, close: async () => {} },
    });
    await publisher.connect();
    const headers = { tenant: 't1' };
    expect(await publisher.publishJob('build', { value: 1 }, { headers })).toBe('message-id');
    const body = publish.mock.calls[0] as unknown as [string, string];
    expect(body).toEqual([
      'topic',
      encodeSqsEnvelope({ id: 'fake-uuid-0', name: 'build', data: { value: 1 }, headers }),
      { abortSignal: expect.any(AbortSignal) },
    ]);
    expect(decodeSqsEnvelope(body[1], 'build')).toMatchObject({ ok: true });
    expect(JSON.parse(body[1])).not.toHaveProperty('maxAttempts');
    expect(headers).toEqual({ tenant: 't1' });
    await publisher.disconnect();
  });
  it('requires runtime or explicit id and validates the same encoder inputs', async () => {
    const publisher = new SnsPublisher({
      topicArn: 'topic',
      client: { publish: () => Promise.resolve(undefined), close: async () => {} },
    });
    await expect(publisher.publishJob('build', {})).rejects.toThrow('not connected');
    await publisher.connect();
    await expect(publisher.publishJob('build', {})).rejects.toThrow(/options.id.*runtime/);
    expect(
      await publisher.publishJob('build', {}, { id: 'explicit', maxAttempts: 5 }),
    ).toBeUndefined();
    await expect(
      publisher.publishJob('build', {}, { id: 'explicit', maxAttempts: NaN }),
    ).rejects.toThrow(TypeError);
    await publisher.disconnect();
  });
  it.each([true, false])(
    'injects a producer context only when valid=%s, without SNS attributes',
    async (valid) => {
      const { service, spans } = fakeTelemetry(valid);
      const publish = vi.fn<(topic: string, body: string) => Promise<string | undefined>>(() =>
        Promise.resolve('mid'),
      );
      const publisher = new SnsPublisher({
        topicArn: 'topic',
        telemetry: service,
        client: { publish, close: async () => {} },
      });
      await publisher.connect();
      const headers = { traceparent: 'caller', tenant: 't1' };
      await publisher.publishJob('build', null, { id: 'j1', headers });
      expect(publish.mock.calls[0]).toHaveLength(3);
      expect(JSON.parse(publish.mock.calls[0]![1]).headers).toEqual({
        traceparent: valid ? TRACEPARENT : 'caller',
        tenant: 't1',
      });
      expect(spans).toHaveBeenCalledWith(
        'enqueue build',
        expect.objectContaining({ kind: 'producer' }),
      );
      expect(headers.traceparent).toBe('caller');
      await publisher.publish('unchanged');
      expect(publish.mock.calls[1]).toEqual([
        'topic',
        'unchanged',
        { abortSignal: expect.any(AbortSignal) },
      ]);
      expect(spans).toHaveBeenCalledTimes(1);
      await publisher.disconnect();
    },
  );
});
