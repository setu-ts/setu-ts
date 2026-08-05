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
        send: async (_cmd: unknown) => ({
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
  });
});
