import { describe, it, expect } from 'vitest';
import { definition } from '../fixtures/harness.ts';
import { defineAgentRun } from '../../src/index.ts';
describe('defineAgentRun', () => {
  it('freezes snapshots and supplies a step bound', () => {
    const d = definition({ compatibleVersions: ['0'], timeouts: { modelMs: 10, toolMs: 20 } });
    expect(d.maxSteps).toBe(20);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.timeouts)).toBe(true);
    expect(Object.isFrozen(d.compatibleVersions)).toBe(true);
  });
  it('refuses hostile or dead configurations', () => {
    for (const value of [NaN, Infinity, -1, 0, 1.5, 1001])
      expect(() => definition({ maxSteps: value })).toThrow();
    for (const input of [
      { name: '' },
      { version: '' },
      { maxOutputTokens: 0 },
      { compatibleVersions: [''] },
      { system: 42 },
      { toolsContext: false },
      { timeouts: { modelMs: -1 } },
      { approval: { tools: { missing: true } } },
      { approval: { timeoutMs: Infinity, tools: {} } },
      { tools: { broken: {} } },
    ])
      expect(() => defineAgentRun({ ...definition(), ...input } as never)).toThrow();
    expect(() => defineAgentRun(null as never)).toThrow();
  });
});
