import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CloudBrokerUnavailableError,
  IntegrationEventRejectedError,
  MessagingNotSupportedError,
  RemoteHandlerError,
  ReplyInboxUnavailableError,
  RequestTimeoutError,
} from '../../src/errors.ts';

describe('messaging errors', () => {
  it('RequestTimeoutError has correct name and message', () => {
    const err = new RequestTimeoutError();
    expect(err.name).toBe('RequestTimeoutError');
    expect(err.message).toContain('timed out');
    expect(err).toBeInstanceOf(Error);
  });

  it('RemoteHandlerError carries remoteMessage', () => {
    const err = new RemoteHandlerError('handler crashed');
    expect(err.name).toBe('RemoteHandlerError');
    expect(err.remoteMessage).toBe('handler crashed');
    expect(err.message).toContain('handler crashed');
    expect(err).toBeInstanceOf(Error);
  });

  it('MessagingNotSupportedError is deprecated but present', () => {
    const err = new MessagingNotSupportedError();
    expect(err.name).toBe('MessagingNotSupportedError');
    expect(err).toBeInstanceOf(Error);
  });

  it('CloudBrokerUnavailableError names backend and specifier', () => {
    const err = new CloudBrokerUnavailableError('GCP Pub/Sub', 'npm:@google-cloud/pubsub@^6');
    expect(err.name).toBe('CloudBrokerUnavailableError');
    expect(err.message).toContain('GCP Pub/Sub');
    expect(err.message).toContain('npm:@google-cloud/pubsub@^6');
    expect(err.message).toContain('Cloudflare Workers');
    expect(err).toBeInstanceOf(Error);
  });

  it('ReplyInboxUnavailableError names the topic', () => {
    const err = new ReplyInboxUnavailableError('messaging.replies');
    expect(err.name).toBe('ReplyInboxUnavailableError');
    expect(err.message).toContain('messaging.replies');
    expect(err.message).toContain('Manage');
    expect(err).toBeInstanceOf(Error);
  });

  it('IntegrationEventRejectedError carries its structured fields and is an Error', () => {
    const err = new IntegrationEventRejectedError({
      reason: 'type-mismatch',
      topic: 'orders.placed.v1',
      expectedType: 'orders.placed',
      expectedVersion: 1,
      detail: 'the envelope declares type "orders.cancelled"',
    });
    expect(err.name).toBe('IntegrationEventRejectedError');
    expect(err.reason).toBe('type-mismatch');
    expect(err.topic).toBe('orders.placed.v1');
    expect(err.expectedType).toBe('orders.placed');
    expect(err.expectedVersion).toBe(1);
    expect(err).toBeInstanceOf(Error);
  });

  it('IntegrationEventRejectedError composes the whole diagnostic into its message', () => {
    const err = new IntegrationEventRejectedError({
      reason: 'version-mismatch',
      topic: 'orders.placed.v1',
      expectedType: 'orders.placed',
      expectedVersion: 1,
      detail: 'the envelope declares version 2',
    });
    // The default in-memory composition flattens rejections to `error.message`
    // — the message must carry the reason, topic, and expected version alone.
    expect(err.message).toContain('version-mismatch');
    expect(err.message).toContain('orders.placed.v1');
    expect(err.message).toContain('version 1');
    expect(err.message).toContain('the envelope declares version 2');
  });

  it('IntegrationEventRejectedError carries cause when given and omits it otherwise', () => {
    const cause = new Error('orderId: expected string');
    const withCause = new IntegrationEventRejectedError({
      reason: 'parse',
      topic: 'orders.placed.v1',
      expectedType: 'orders.placed',
      expectedVersion: 1,
      detail: 'the parse function rejected the payload — orderId: expected string',
      cause,
    });
    expect(withCause.cause).toBe(cause);

    const withoutCause = new IntegrationEventRejectedError({
      reason: 'malformed',
      topic: 'orders.placed.v1',
      expectedType: 'orders.placed',
      expectedVersion: 1,
      detail: 'the delivered message is not a JSON object',
    });
    expect((withoutCause as { cause?: unknown }).cause).toBeUndefined();
  });
});
