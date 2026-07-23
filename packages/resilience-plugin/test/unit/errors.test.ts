import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BulkheadFullError, CircuitOpenError, TimeoutError } from '../../src/errors.ts';

describe('resilience errors', () => {
  it('TimeoutError is an Error with its own name and preserves the message', () => {
    const err = new TimeoutError('deadline exceeded');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof TimeoutError).toBe(true);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toBe('deadline exceeded');
  });

  it('TimeoutError has a default message', () => {
    expect(new TimeoutError().message).toBe('Operation timed out');
  });

  it('BulkheadFullError is an Error with its own name and preserves the message', () => {
    const err = new BulkheadFullError('shed');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof BulkheadFullError).toBe(true);
    expect(err.name).toBe('BulkheadFullError');
    expect(err.message).toBe('shed');
  });

  it('BulkheadFullError has a default message', () => {
    expect(new BulkheadFullError().message).toBe('Bulkhead is full');
  });

  it('CircuitOpenError is an Error with its own name and preserves the message', () => {
    const err = new CircuitOpenError('open');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof CircuitOpenError).toBe(true);
    expect(err.name).toBe('CircuitOpenError');
    expect(err.message).toBe('open');
  });

  it('CircuitOpenError has a default message', () => {
    expect(new CircuitOpenError().message).toBe('Circuit breaker is open');
  });

  it('the three error types are mutually distinguishable via instanceof', () => {
    expect(new TimeoutError() instanceof BulkheadFullError).toBe(false);
    expect(new BulkheadFullError() instanceof CircuitOpenError).toBe(false);
    expect(new CircuitOpenError() instanceof TimeoutError).toBe(false);
  });
});
