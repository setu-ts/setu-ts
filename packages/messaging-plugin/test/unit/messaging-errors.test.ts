import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  MessagingNotSupportedError,
  RemoteHandlerError,
  RequestTimeoutError,
} from '../../src/errors.ts';

describe('request-reply errors', () => {
  it('RequestTimeoutError has a default message and name', () => {
    const err = new RequestTimeoutError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RequestTimeoutError');
    expect(err.message).toContain('timed out');
  });

  it('RequestTimeoutError accepts a custom message', () => {
    const err = new RequestTimeoutError('custom');
    expect(err.message).toBe('custom');
  });

  it('RemoteHandlerError carries the remote message', () => {
    const err = new RemoteHandlerError('downstream boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RemoteHandlerError');
    expect(err.remoteMessage).toBe('downstream boom');
    expect(err.message).toContain('downstream boom');
  });

  it('MessagingNotSupportedError has a default message naming reply-capable brokers', () => {
    const err = new MessagingNotSupportedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MessagingNotSupportedError');
    expect(err.message).toContain('request-reply');
  });

  it('MessagingNotSupportedError accepts a custom message', () => {
    const err = new MessagingNotSupportedError('nope');
    expect(err.message).toBe('nope');
  });
});
