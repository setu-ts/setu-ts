/**
 * Unit tests for the worker-pool error classes.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  WorkerPoolUnavailableError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '../../src/errors.ts';

describe('WorkerPoolUnavailableError', () => {
  it('should default its message and set its name', () => {
    const error = new WorkerPoolUnavailableError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WorkerPoolUnavailableError);
    expect(error.name).toBe('WorkerPoolUnavailableError');
    expect(error.message).toContain('not available');
  });

  it('should accept a custom message', () => {
    expect(new WorkerPoolUnavailableError('shut down').message).toBe('shut down');
  });
});

describe('WorkerTaskError', () => {
  it('should carry the task module and the remote error shape', () => {
    const error = new WorkerTaskError('file:///t.ts', {
      name: 'RangeError',
      message: 'nope',
      stack: 'RangeError: nope\n  at t.ts:1',
    });
    expect(error).toBeInstanceOf(WorkerTaskError);
    expect(error.name).toBe('WorkerTaskError');
    expect(error.taskModule).toBe('file:///t.ts');
    expect(error.remoteName).toBe('RangeError');
    expect(error.remoteStack).toContain('at t.ts:1');
    expect(error.message).toBe('Worker task failed (file:///t.ts): RangeError: nope');
  });

  it('should omit remoteStack when the remote shape has none', () => {
    const error = new WorkerTaskError('file:///t.ts', { name: 'Error', message: 'x' });
    expect(error.remoteStack).toBeUndefined();
  });
});

describe('WorkerTaskTimeoutError', () => {
  it('should carry the task module and elapsed timeout', () => {
    const error = new WorkerTaskTimeoutError('file:///t.ts', 5000);
    expect(error).toBeInstanceOf(WorkerTaskTimeoutError);
    expect(error.name).toBe('WorkerTaskTimeoutError');
    expect(error.taskModule).toBe('file:///t.ts');
    expect(error.timeoutMs).toBe(5000);
    expect(error.message).toBe('Worker task timed out after 5000ms (file:///t.ts)');
  });
});

describe('WorkerQueueFullError', () => {
  it('should carry the task module and queue bound', () => {
    const error = new WorkerQueueFullError('file:///t.ts', 10);
    expect(error).toBeInstanceOf(WorkerQueueFullError);
    expect(error.name).toBe('WorkerQueueFullError');
    expect(error.taskModule).toBe('file:///t.ts');
    expect(error.limit).toBe(10);
    expect(error.message).toBe('Worker pool queue is full (10 pending) for file:///t.ts');
  });
});
