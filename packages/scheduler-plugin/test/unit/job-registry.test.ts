/**
 * Tests for JobRegistry.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { JobRegistry } from '../../src/jobs/job-registry.ts';
import type { RegistryEntry } from '../../src/interfaces/index.ts';

describe('JobRegistry', () => {
  function makeEntry(name: string): RegistryEntry<unknown> {
    return {
      name,
      kind: 'cron',
      expression: '* * * * *',
      handler: () => {},
      paused: false,
      nextRunAtMs: 1000,
      timerHandle: null,
    };
  }

  it('adds and gets entry', () => {
    const registry = new JobRegistry();
    const entry = makeEntry('job1');
    registry.add(entry);
    const got = registry.get('job1');
    expect(got.name).toBe('job1');
  });

  it('throws on duplicate name', () => {
    const registry = new JobRegistry();
    registry.add(makeEntry('job1'));
    try {
      registry.add(makeEntry('job1'));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("Job 'job1' is already scheduled");
    }
  });

  it('throws on unknown name get', () => {
    const registry = new JobRegistry();
    try {
      registry.get('missing');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'missing'");
    }
  });

  it('has returns true/false', () => {
    const registry = new JobRegistry();
    expect(registry.has('job1')).toBe(false);
    registry.add(makeEntry('job1'));
    expect(registry.has('job1')).toBe(true);
  });

  it('removes entry', () => {
    const registry = new JobRegistry();
    registry.add(makeEntry('job1'));
    registry.remove('job1');
    expect(registry.has('job1')).toBe(false);
  });

  it('throws on remove unknown name', () => {
    const registry = new JobRegistry();
    try {
      registry.remove('missing');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'missing'");
    }
  });

  it('pauses entry and clears timer', () => {
    const registry = new JobRegistry();
    const entry = makeEntry('job1');
    entry.timerHandle = 42;
    registry.add(entry);
    let clearedHandle: unknown;
    registry.pause('job1', (handle) => {
      clearedHandle = handle;
    });
    const paused = registry.get('job1');
    expect(paused.paused).toBe(true);
    expect(clearedHandle).toBe(42);
  });

  it('pause is idempotent', () => {
    const registry = new JobRegistry();
    registry.add(makeEntry('job1'));
    registry.pause('job1', () => {});
    registry.pause('job1', () => {});
    const entry = registry.get('job1');
    expect(entry.paused).toBe(true);
  });

  it('throws on pause unknown name', () => {
    const registry = new JobRegistry();
    try {
      registry.pause('missing', () => {});
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'missing'");
    }
  });

  it('getNextRun returns fire time', () => {
    const registry = new JobRegistry();
    registry.add(makeEntry('job1'));
    expect(registry.getNextRun('job1')).toBe(1000);
  });

  it('throws getNextRun on paused', () => {
    const registry = new JobRegistry();
    registry.add(makeEntry('job1'));
    registry.pause('job1', () => {});
    try {
      registry.getNextRun('job1');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("Job 'job1' is paused");
    }
  });

  it('throws getNextRun on unknown name', () => {
    const registry = new JobRegistry();
    try {
      registry.getNextRun('missing');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'missing'");
    }
  });

  it('resume updates entry state', () => {
    const registry = new JobRegistry();
    registry.add(makeEntry('job1'));
    registry.pause('job1', () => {});
    // Resume manually by updating fields (resume is handled by service)
    const entry = registry.get('job1');
    entry.paused = false;
    entry.nextRunAtMs = 2000;
    expect(entry.paused).toBe(false);
    expect(registry.getNextRun('job1')).toBe(2000);
  });
});
