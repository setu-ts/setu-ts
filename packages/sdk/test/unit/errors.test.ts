/**
 * Tests for SDK error classes.
 *
 * Covers `HttpClientError`, `ClientCircuitOpenError`, and `OpenApiCodegenError`
 * — name, instanceof, message, and field shapes.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ClientCircuitOpenError, HttpClientError, OpenApiCodegenError } from '../../src/errors.ts';

describe('HttpClientError', () => {
  it('has correct name', () => {
    const err = new HttpClientError('fail', 500, new Headers(), null);
    expect(err.name).toEqual('HttpClientError');
  });

  it('is instanceof Error', () => {
    const err = new HttpClientError('fail', 500, new Headers(), null);
    expect(err).toBeInstanceOf(Error);
  });

  it('is instanceof HttpClientError', () => {
    const err = new HttpClientError('fail', 500, new Headers(), null);
    expect(err).toBeInstanceOf(HttpClientError);
  });

  it('carries status, headers, and body', () => {
    const headers = new Headers({ 'x-foo': 'bar' });
    const body = { detail: 'boom' };
    const err = new HttpClientError('Internal Server Error', 500, headers, body);

    expect(err.status).toEqual(500);
    expect(err.headers.get('x-foo')).toEqual('bar');
    expect(err.body).toEqual(body);
  });

  it('message is set from constructor argument', () => {
    const err = new HttpClientError('my message', 404, new Headers(), null);
    expect(err.message).toEqual('my message');
  });
});

describe('ClientCircuitOpenError', () => {
  it('has correct name', () => {
    const err = new ClientCircuitOpenError('circuit open');
    expect(err.name).toEqual('ClientCircuitOpenError');
  });

  it('is instanceof Error', () => {
    const err = new ClientCircuitOpenError('circuit open');
    expect(err).toBeInstanceOf(Error);
  });

  it('is instanceof ClientCircuitOpenError', () => {
    const err = new ClientCircuitOpenError('circuit open');
    expect(err).toBeInstanceOf(ClientCircuitOpenError);
  });

  it('message is set from constructor argument', () => {
    const err = new ClientCircuitOpenError('my message');
    expect(err.message).toEqual('my message');
  });
});

describe('OpenApiCodegenError', () => {
  it('has correct name', () => {
    const err = new OpenApiCodegenError('bad spec');
    expect(err.name).toEqual('OpenApiCodegenError');
  });

  it('is instanceof Error', () => {
    const err = new OpenApiCodegenError('bad spec');
    expect(err).toBeInstanceOf(Error);
  });

  it('is instanceof OpenApiCodegenError', () => {
    const err = new OpenApiCodegenError('bad spec');
    expect(err).toBeInstanceOf(OpenApiCodegenError);
  });

  it('carries path and method diagnostics', () => {
    const err = new OpenApiCodegenError('duplicate operation', '/users/{id}', 'GET');
    expect(err.path).toEqual('/users/{id}');
    expect(err.method).toEqual('GET');
  });

  it('path and method are undefined when not provided', () => {
    const err = new OpenApiCodegenError('generic error');
    expect(err.path).toBeUndefined();
    expect(err.method).toBeUndefined();
  });
});
