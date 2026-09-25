/**
 * Unit tests for the health-observation option validator (M98d): the ONE
 * compile step the plugin factory runs at construction. Every refusal is a
 * fixed, value-free `RangeError`; a supplied value is never echoed.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  COLLECTOR_ERRORS,
  compileHealthDiagnosticsPolicy,
} from '../../src/diagnostics/health-observation-collector.ts';
import type { HealthDiagnosticsOptions } from '../../src/interfaces/index.ts';
import { HealthPlugin } from '../../src/plugin/health-plugin.ts';

function options(overrides: Record<string, unknown> = {}): HealthDiagnosticsOptions {
  return {
    enabled: true,
    indicators: { 'db.check': 'database', 'cache.check': 'cache' },
    ...overrides,
  } as HealthDiagnosticsOptions;
}

const compile = (overrides: Record<string, unknown> = {}) => () =>
  compileHealthDiagnosticsPolicy(options(overrides));

const schedule = (overrides: Record<string, unknown> = {}) => ({
  indicators: ['db.check'],
  intervalMs: 1000,
  timeoutMs: 1,
  concurrency: 1,
  ...overrides,
});

describe('compileHealthDiagnosticsPolicy', () => {
  it('compiles a valid policy with the default stale bound and no schedule', () => {
    const policy = compileHealthDiagnosticsPolicy(options());
    expect([...policy.aliasBySourceName]).toEqual([
      ['db.check', 'database'],
      ['cache.check', 'cache'],
    ]);
    expect([...policy.sourceNameByAlias.keys()]).toEqual(['database', 'cache']);
    expect(policy.staleAfterMs).toBe(30_000);
    expect(policy.scheduled).toBeNull();
  });

  it('compiles a schedule, de-duplicating repeated names in declared order', () => {
    const policy = compileHealthDiagnosticsPolicy(
      options({
        scheduled: schedule({
          indicators: ['cache.check', 'db.check', 'cache.check'],
          concurrency: 4,
        }),
      }),
    );
    expect(policy.scheduled).toEqual({
      names: ['cache.check', 'db.check'],
      intervalMs: 1000,
      timeoutMs: 1,
      concurrency: 4,
    });
  });

  it('refuses a non-object option and any enabled value other than the literal true', () => {
    expect(() => compileHealthDiagnosticsPolicy(null as never)).toThrow(
      COLLECTOR_ERRORS.badOptions,
    );
    for (const enabled of [false, 'true', 1, undefined]) {
      expect(compile({ enabled })).toThrow(COLLECTOR_ERRORS.notEnabled);
    }
  });

  it('refuses indicators that are not a name-to-alias record', () => {
    expect(compile({ indicators: null })).toThrow(COLLECTOR_ERRORS.badIndicators);
    expect(compile({ indicators: ['database'] })).toThrow(COLLECTOR_ERRORS.badIndicators);
    expect(compile({ indicators: { a: 7 } })).toThrow(COLLECTOR_ERRORS.badIndicators);
  });

  it('refuses more than 64 approved indicators', () => {
    const indicators: Record<string, string> = {};
    for (let i = 0; i < 65; i++) {
      indicators[`name${i}`] = `alias${i}`;
    }
    expect(compile({ indicators })).toThrow(COLLECTOR_ERRORS.tooManyAliases);
  });

  it('refuses an empty, oversized, control-bearing, or duplicate alias', () => {
    expect(compile({ indicators: { a: '' } })).toThrow(COLLECTOR_ERRORS.aliasBytes);
    expect(compile({ indicators: { a: 'x'.repeat(65) } })).toThrow(COLLECTOR_ERRORS.aliasBytes);
    // 22 × 3-byte characters = 66 UTF-8 bytes although only 22 code units.
    expect(compile({ indicators: { a: '€'.repeat(22) } })).toThrow(COLLECTOR_ERRORS.aliasBytes);
    expect(compile({ indicators: { a: 'bad\x01name' } })).toThrow(COLLECTOR_ERRORS.aliasControl);
    expect(compile({ indicators: { a: 'bad\x9bname' } })).toThrow(COLLECTOR_ERRORS.aliasControl);
    expect(compile({ indicators: { a: 'same', b: 'same' } })).toThrow(
      COLLECTOR_ERRORS.duplicateAlias,
    );
  });

  it('refuses a non-positive, non-integer, or non-finite staleAfterMs', () => {
    for (const staleAfterMs of [0, -1, 1.5, Number.NaN, Infinity, '30000']) {
      expect(compile({ staleAfterMs })).toThrow(COLLECTOR_ERRORS.badStaleAfter);
    }
  });

  it('refuses a malformed schedule and scheduled names that are not approved', () => {
    expect(compile({ scheduled: null })).toThrow(COLLECTOR_ERRORS.badScheduled);
    expect(compile({ scheduled: schedule({ indicators: 'db.check' }) })).toThrow(
      COLLECTOR_ERRORS.badScheduled,
    );
    expect(compile({ scheduled: schedule({ indicators: ['not-approved'] }) })).toThrow(
      COLLECTOR_ERRORS.scheduledNotApproved,
    );
    expect(compile({ scheduled: schedule({ indicators: [7] }) })).toThrow(
      COLLECTOR_ERRORS.scheduledNotApproved,
    );
    const indicators: Record<string, string> = {};
    for (let i = 0; i < 17; i++) {
      indicators[`n${i}`] = `a${i}`;
    }
    expect(compile({ indicators, scheduled: schedule({ indicators: Object.keys(indicators) }) }))
      .toThrow(COLLECTOR_ERRORS.tooManyScheduled);
  });

  it('refuses out-of-range or non-integer interval, timeout, and concurrency', () => {
    for (const intervalMs of [999, 300_001, 1000.5, Number.NaN]) {
      expect(compile({ scheduled: schedule({ intervalMs }) })).toThrow(
        COLLECTOR_ERRORS.badInterval,
      );
    }
    for (const timeoutMs of [0, 30_001, Infinity]) {
      expect(compile({ scheduled: schedule({ timeoutMs }) })).toThrow(COLLECTOR_ERRORS.badTimeout);
    }
    for (const concurrency of [0, 5, 1.5]) {
      expect(compile({ scheduled: schedule({ concurrency }) })).toThrow(
        COLLECTOR_ERRORS.badConcurrency,
      );
    }
  });

  it('never echoes a supplied value in a refusal', () => {
    const canary = 'canary-alias-\x01';
    try {
      compileHealthDiagnosticsPolicy(options({ indicators: { 'canary-name': canary } }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('canary');
    }
  });
});

describe('HealthPlugin — diagnostics validated at construction', () => {
  it('refuses an invalid policy when HealthPlugin(...) is called, before any application', () => {
    expect(() => HealthPlugin({ diagnostics: options({ indicators: { a: '' } }) })).toThrow(
      COLLECTOR_ERRORS.aliasBytes,
    );
    expect(() => HealthPlugin({ diagnostics: options({ enabled: false }) })).toThrow(
      COLLECTOR_ERRORS.notEnabled,
    );
  });

  it('constructs with a valid policy or with diagnostics absent', () => {
    expect(() => HealthPlugin({ diagnostics: options() })).not.toThrow();
    expect(() => HealthPlugin()).not.toThrow();
  });
});
