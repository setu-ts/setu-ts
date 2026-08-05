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
});
