/**
 * Unit tests for the worker-pool contracts: protocol guards and the
 * WORKER_POOL capability token.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  CAPABILITIES,
  createCapabilityToken,
  isWorkerReadySignal,
  isWorkerTaskReply,
  isWorkerTaskRequest,
} from '../../src/index.ts';
import type { WorkerReadySignal, WorkerTaskReply, WorkerTaskRequest } from '../../src/index.ts';

describe('CAPABILITIES.WORKER_POOL', () => {
  it('should be the lowercase kebab token "worker-pool"', () => {
    expect(CAPABILITIES.WORKER_POOL).toBe('worker-pool');
  });

  it('should pass the committed token grammar', () => {
    expect(createCapabilityToken(CAPABILITIES.WORKER_POOL)).toBe('worker-pool');
  });
});

describe('isWorkerReadySignal', () => {
  it('should accept a conforming ready envelope', () => {
    const message: WorkerReadySignal = { __hewp: 1, kind: 'ready' };
    expect(isWorkerReadySignal(message)).toBe(true);
  });

  it('should reject null, primitives, and plain objects', () => {
    expect(isWorkerReadySignal(null)).toBe(false);
    expect(isWorkerReadySignal(42)).toBe(false);
    expect(isWorkerReadySignal({})).toBe(false);
    expect(isWorkerReadySignal({ kind: 'ready' })).toBe(false);
  });

  it('should reject an envelope with a different kind', () => {
    expect(isWorkerReadySignal({ __hewp: 1, kind: 'task' })).toBe(false);
  });

  it('should reject an envelope whose kind is not a string', () => {
    expect(isWorkerReadySignal({ __hewp: 1, kind: 7 })).toBe(false);
  });
});

describe('isWorkerTaskRequest', () => {
  it('should accept a conforming task envelope', () => {
    const message: WorkerTaskRequest = { __hewp: 1, kind: 'task', id: 3, input: { n: 1 } };
    expect(isWorkerTaskRequest(message)).toBe(true);
  });

  it('should reject a task envelope without a numeric id', () => {
    expect(isWorkerTaskRequest({ __hewp: 1, kind: 'task', input: 1 })).toBe(false);
    expect(isWorkerTaskRequest({ __hewp: 1, kind: 'task', id: 'x', input: 1 })).toBe(false);
  });

  it('should reject other envelope kinds and non-envelopes', () => {
    expect(isWorkerTaskRequest({ __hewp: 1, kind: 'ready' })).toBe(false);
    expect(isWorkerTaskRequest(undefined)).toBe(false);
  });
});

describe('isWorkerTaskReply', () => {
  it('should accept ok and error replies', () => {
    const ok: WorkerTaskReply = { __hewp: 1, kind: 'reply', id: 1, ok: true, result: 2 };
    const fail: WorkerTaskReply = {
      __hewp: 1,
      kind: 'reply',
      id: 2,
      ok: false,
      error: { name: 'Error', message: 'boom' },
    };
    expect(isWorkerTaskReply(ok)).toBe(true);
    expect(isWorkerTaskReply(fail)).toBe(true);
  });

  it('should reject replies missing id or ok', () => {
    expect(isWorkerTaskReply({ __hewp: 1, kind: 'reply', ok: true })).toBe(false);
    expect(isWorkerTaskReply({ __hewp: 1, kind: 'reply', id: 1 })).toBe(false);
  });

  it('should reject a wrong protocol marker', () => {
    expect(isWorkerTaskReply({ __hewp: 2, kind: 'reply', id: 1, ok: true })).toBe(false);
  });
});
