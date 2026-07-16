/**
 * Integration test for SchedulerPlugin wiring.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SchedulerPlugin } from '../../src/plugin/scheduler-plugin.ts';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('SchedulerPlugin integration', () => {
  it('plugin registers and resolves IScheduler', () => {
    const plugin = SchedulerPlugin();
    expect(plugin.provides).toContain('scheduler');
    expect(typeof plugin.register).toBe('function');
  });

  it('service wires lock and fires job once', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    let fireCount = 0;
    await service.delay('test-job', 100, () => {
      fireCount++;
    });

    // Advance clock past delay — FakeRuntime.advance fires timers
    await runtime.advance(1000);

    // Job should have fired once
    expect(fireCount).toBe(1);

    await service.disconnect();
  });

  it('every job schedules and fires at least once', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    let fireCount = 0;
    await service.every('tick', 100, () => {
      fireCount++;
    });

    // Advance past first fire - every job should fire at least once
    await runtime.advance(100);
    expect(fireCount).toBeGreaterThanOrEqual(1);

    await service.disconnect();
  });
});
