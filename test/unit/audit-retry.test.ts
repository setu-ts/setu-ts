/** Retry and fail-closed controls for pnpm audit JSON. @module */
import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  classifyAudit,
  runAuditLoop,
  shouldRetry,
  type AuditRun,
} from '../../scripts/audit.ts';

const clean = { code: 0, stdout: '{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}' };
const registry = {
  code: 1,
  stdout: '{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"503"}}',
};
const advisory = { code: 1, stdout: '{"metadata":{"vulnerabilities":{"high":1,"critical":0}}}' };
describe('pnpm audit', () => {
  it('distinguishes clean, advisory, registry and unclassifiable outcomes', () => {
    expect(classifyAudit(clean).kind).toBe('clean');
    expect(classifyAudit(registry).kind).toBe('registry');
    for (const result of [
      advisory,
      { code: 1, stdout: '{"metadata":{"vulnerabilities":{"critical":1}}}' },
      { code: 2, stdout: 'garbage' },
      { code: 1, stdout: '{}' },
      { code: 1, stdout: 'null' },
      { code: 1, stdout: '{"error":{},"metadata":{"vulnerabilities":{"high":1}}}' },
    ])
      expect(classifyAudit(result).kind).toBe('advisory');
  });
  it('bounds exponential backoff and retries by count and time', () => {
    expect([0, 1, 2, 3, 1000].map(backoffMs)).toEqual([0, 0, 2000, 4000, 30000]);
    expect(shouldRetry(1, 0)).toBe(true);
    expect(shouldRetry(3, 0)).toBe(false);
    expect(shouldRetry(1, 720000)).toBe(false);
  });
  it.each([
    { runs: [clean], code: 0, calls: 1, waits: [] },
    { runs: [advisory], code: 1, calls: 1, waits: [] },
    { runs: [registry, clean], code: 0, calls: 2, waits: [2000] },
    { runs: [registry, registry, registry], code: 1, calls: 3, waits: [2000, 4000] },
    { runs: [{ code: 124, stdout: '', timedOut: true }], code: 1, calls: 1, waits: [] },
    { runs: [{ code: 101, stdout: '{}' }], code: 101, calls: 1, waits: [] },
  ])('runs the specified retry policy: $runs', async ({ runs, code, calls, waits }) => {
    let n = 0;
    const slept: number[] = [];
    const budgets: number[] = [];
    expect(
      await runAuditLoop({
        run: (budget) => {
          budgets.push(budget);
          return Promise.resolve(runs[n++] as AuditRun);
        },
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        now: () => n * 1000,
        log: () => {},
      }),
    ).toBe(code);
    expect(n).toBe(calls);
    expect(slept).toEqual(waits);
    expect(budgets.every((b, i) => i === 0 || b < budgets[i - 1]!)).toBe(true);
  });
  it('does not start a process after its sleep consumed the budget', async () => {
    let clock = 0;
    let calls = 0;
    expect(
      await runAuditLoop({
        run: () => {
          calls++;
          return Promise.resolve(registry);
        },
        sleep: () => {
          clock = 720000;
          return Promise.resolve();
        },
        now: () => clock,
        log: () => {},
      }),
    ).toBe(1);
    expect(calls).toBe(1);
  });
});
