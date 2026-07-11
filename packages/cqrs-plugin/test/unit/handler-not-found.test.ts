/**
 * HandlerNotFoundError tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HandlerNotFoundError } from '../../src/errors/handler-not-found.ts';

describe('HandlerNotFoundError', () => {
  it('should be an instance of Error', () => {
    const err = new HandlerNotFoundError('TestRequest');
    expect(err).toBeInstanceOf(Error);
  });

  it('should have name "HandlerNotFoundError"', () => {
    const err = new HandlerNotFoundError('TestRequest');
    expect(err.name).toBe('HandlerNotFoundError');
  });

  it('should include the request type in the message', () => {
    const err = new HandlerNotFoundError('CreateUser');
    expect(err.message).toContain('CreateUser');
    expect(err.message).toBe("No handler registered for request type 'CreateUser'.");
  });

  it('should have a requestType field', () => {
    const err = new HandlerNotFoundError('GetUser');
    expect(err.requestType).toBe('GetUser');
  });

  it('should round-trip the request type', () => {
    const type = 'DeleteUser';
    const err = new HandlerNotFoundError(type);
    expect(err.requestType).toBe(type);
  });
});
