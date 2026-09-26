import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ITraceDiagnosticsSource } from '@setu-ts/common';

import {
  compileTraceDiagnosticsPolicy,
  createInactiveTraceSource,
  isSpanId,
  isTraceId,
  TRACE_COLLECTOR_ERRORS,
  TRACE_COLLECTOR_LIMITS,
  validateTraceReadArgs,
} from '../../src/diagnostics/span-observation-collector.ts';

const VALID_OPTIONS = {
  enabled: true as const,
  serviceAlias: 'orders',
  operations: { 'POST /orders': 'create-order' },
};

describe('compileTraceDiagnosticsPolicy', () => {
  it('compiles a valid policy', () => {
    const policy = compileTraceDiagnosticsPolicy(VALID_OPTIONS);
    expect(policy.serviceAlias).toBe('orders');
    expect(policy.aliasByName.get('POST /orders')).toBe('create-order');
  });

  it('refuses a non-object option bag', () => {
    expect(() => compileTraceDiagnosticsPolicy(null as never)).toThrow(
      TRACE_COLLECTOR_ERRORS.badOptions,
    );
    expect(() => compileTraceDiagnosticsPolicy([1] as never)).toThrow(
      TRACE_COLLECTOR_ERRORS.badOptions,
    );
  });

  it('refuses enabled other than the literal true', () => {
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, enabled: false as never }))
      .toThrow(TRACE_COLLECTOR_ERRORS.notEnabled);
  });

  it('refuses a bad service alias', () => {
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, serviceAlias: '' })).toThrow(
      TRACE_COLLECTOR_ERRORS.aliasBytes,
    );
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, serviceAlias: 'a'.repeat(65) }))
      .toThrow(TRACE_COLLECTOR_ERRORS.aliasBytes);
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, serviceAlias: 'bad\nalias' }))
      .toThrow(TRACE_COLLECTOR_ERRORS.aliasControl);
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, serviceAlias: 7 as never }))
      .toThrow(TRACE_COLLECTOR_ERRORS.badServiceAlias);
  });

  it('refuses bad operation maps', () => {
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, operations: 'nope' as never }))
      .toThrow(TRACE_COLLECTOR_ERRORS.badOperations);
    expect(() =>
      compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, operations: { span: 3 as never } })
    ).toThrow(TRACE_COLLECTOR_ERRORS.badOperations);
  });

  it('refuses more than the operation bound', () => {
    const operations: Record<string, string> = {};
    for (let index = 0; index <= TRACE_COLLECTOR_LIMITS.approvedOperations; index++) {
      operations[`span-${index}`] = `op-${index}`;
    }
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, operations })).toThrow(
      TRACE_COLLECTOR_ERRORS.tooManyOperations,
    );
  });

  it('refuses a duplicate operation alias', () => {
    expect(() =>
      compileTraceDiagnosticsPolicy({
        ...VALID_OPTIONS,
        operations: { 'span-a': 'same', 'span-b': 'same' },
      })
    ).toThrow(TRACE_COLLECTOR_ERRORS.duplicateAlias);
  });

  it('refuses an alias violating the byte bound', () => {
    expect(() => compileTraceDiagnosticsPolicy({ ...VALID_OPTIONS, operations: { span: '' } }))
      .toThrow(TRACE_COLLECTOR_ERRORS.aliasBytes);
  });
});

describe('W3C identifier validation', () => {
  it('accepts well-formed lowercase-hex identifiers', () => {
    expect(isTraceId('a'.repeat(32))).toBe(true);
    expect(isSpanId('b'.repeat(16))).toBe(true);
  });

  it('rejects the all-zero invalid identifiers', () => {
    expect(isTraceId('0'.repeat(32))).toBe(false);
    expect(isSpanId('0'.repeat(16))).toBe(false);
  });

  it('rejects malformed identifiers', () => {
    expect(isTraceId('A'.repeat(32))).toBe(false);
    expect(isTraceId('a'.repeat(31))).toBe(false);
    expect(isTraceId('g'.repeat(32))).toBe(false);
    expect(isTraceId(123)).toBe(false);
    expect(isSpanId('A'.repeat(16))).toBe(false);
    expect(isSpanId('b'.repeat(15))).toBe(false);
  });
});

describe('validateTraceReadArgs', () => {
  it('accepts a valid cursor and defaults the limit', () => {
    expect(validateTraceReadArgs('instance', 0, undefined, 5)).toBe(128);
    expect(validateTraceReadArgs('instance', 5, 1, 5)).toBe(1);
  });

  it('refuses an empty instance id', () => {
    expect(() => validateTraceReadArgs('', 0, undefined, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badInstance,
    );
    expect(() => validateTraceReadArgs(9, 0, undefined, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badInstance,
    );
  });

  it('refuses a bad cursor or limit', () => {
    expect(() => validateTraceReadArgs('instance', -1, undefined, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
    expect(() => validateTraceReadArgs('instance', 1.5, undefined, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
    expect(() => validateTraceReadArgs('instance', 6, undefined, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
    expect(() => validateTraceReadArgs('instance', 0, 0, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
    expect(() => validateTraceReadArgs('instance', 0, 129, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
    expect(() => validateTraceReadArgs('instance', 0, 1.5, 5)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
  });
});

describe('createInactiveTraceSource', () => {
  const availability = {
    coverage: 'noop-no-provider' as const,
    instrumentation: () => [],
    sampler: { kind: 'unknown' as const },
  };

  it('answers a disabled batch bound to the instance', () => {
    const source: ITraceDiagnosticsSource = createInactiveTraceSource('disabled', availability);
    const batch = source.read('instance-1', 0, 64);
    expect(batch).toEqual({
      version: 1,
      instanceId: 'instance-1',
      state: 'disabled',
      coverage: 'noop-no-provider',
      instrumentation: [],
      sampler: { kind: 'unknown' },
      records: [],
      next: 0,
      lost: 0,
      closed: false,
      droppedSpans: 0,
    });
  });

  it('answers an unsupported batch with the fixed coverage reason', () => {
    const source: ITraceDiagnosticsSource = createInactiveTraceSource('unsupported', {
      coverage: 'custom-provider',
      instrumentation: () => [],
      sampler: { kind: 'unknown' },
    });
    const batch = source.read('instance-1', 0);
    expect(batch.state).toBe('unsupported');
    expect(batch.coverage).toBe('custom-provider');
    expect(batch.next).toBe(0);
  });

  it('echoes the requested cursor on an empty page and refuses a beyond-sequence one', () => {
    const source: ITraceDiagnosticsSource = createInactiveTraceSource('disabled', availability);
    expect(source.read('instance-1', 0, undefined).next).toBe(0);
    // The source has never observed anything, so its only valid cursor is 0.
    expect(() => source.read('instance-1', 42, undefined)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
  });

  it('validates its arguments with the same fixed messages as the active source', () => {
    const source: ITraceDiagnosticsSource = createInactiveTraceSource('disabled', availability);
    expect(() => source.read('', 0)).toThrow(TRACE_COLLECTOR_ERRORS.badInstance);
    expect(() => source.read('instance-1', 1, undefined)).toThrow(
      TRACE_COLLECTOR_ERRORS.badCursor,
    );
  });
});
