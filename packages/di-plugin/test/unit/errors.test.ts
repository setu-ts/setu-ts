import { expect, it } from 'vitest';
import { createToken } from '@setu-ts/common';
import {
  ContainerClosedError,
  ContainerValidationError,
  RequestScopeUnavailableError,
  ScopeDisposedError,
  ScopeRequiredError,
} from '../../src/index.ts';

it('names each public error and preserves validation paths and token names', () => {
  class Service {}
  const token = createToken('typed');
  for (const [error, name, message] of [
    [new ContainerClosedError(token), 'ContainerClosedError', 'typed'],
    [new ScopeRequiredError(Service), 'ScopeRequiredError', 'Service'],
    [new ScopeDisposedError('closed'), 'ScopeDisposedError', 'closed'],
    [new RequestScopeUnavailableError(), 'RequestScopeUnavailableError', 'createTestApp'],
  ] as const) {
    expect(error.name).toBe(name);
    expect(error.message).toContain(message);
    expect(error).toBeInstanceOf(Error);
  }
  const findings = [{ kind: 'missing' as const, token, path: [Service, token] }];
  const error = new ContainerValidationError(findings);
  expect(error.name).toBe('ContainerValidationError');
  expect(error.findings).toBe(findings);
  expect(error.message).toContain('Service → typed');
});
