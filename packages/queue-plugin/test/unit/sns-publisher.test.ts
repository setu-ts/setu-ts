import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SnsPublisher } from '../../src/sns/sns-publisher.ts';
import type { ISnsTransport } from '../../src/sns/sns-publisher.ts';

describe('SnsPublisher', () => {
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
        send: (_cmd: unknown) =>
          Promise.resolve({
            MessageId: 'test-msg-id',
          }),
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

      const msgId = await transport.publish('arn:aws:sns:us-east-1:123456:topic', 'hello');
      expect(msgId).toBe('test-msg-id');
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

      adaptSnsModule(
        mod as unknown as import('../../src/sns/sns-publisher.ts').SnsSdkModule,
        {
          region: 'eu-west-1',
          credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
          endpoint: 'http://localstack:4566',
        },
      );

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
    const { loadSnsModule, adaptSnsModule } = await import(
      '../../src/sns/sns-publisher.ts'
    );

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
    adaptSnsModule(
      mod as unknown as import('../../src/sns/sns-publisher.ts').SnsSdkModule,
      {
        region: 'eu-west-1',
        credentials: { accessKeyId: 'SNS-KEY', secretAccessKey: 'sns-secret' },
        endpoint: 'http://local-sns:4566',
      },
    );
    expect(capturedConfig).not.toBeUndefined();
    expect(capturedConfig!.region).toBe('eu-west-1');
    expect(capturedConfig!.endpoint).toBe('http://local-sns:4566');
    expect(capturedConfig!.credentials).toEqual({
      accessKeyId: 'SNS-KEY',
      secretAccessKey: 'sns-secret',
    });
  });
});
