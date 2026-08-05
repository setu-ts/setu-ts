import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CloudBrokerUnavailableError,
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
    const err = new CloudBrokerUnavailableError('GCP Pub/Sub', 'npm:@google-cloud/pubsub@5.x');
    expect(err.name).toBe('CloudBrokerUnavailableError');
    expect(err.message).toContain('GCP Pub/Sub');
    expect(err.message).toContain('npm:@google-cloud/pubsub@5.x');
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
});
