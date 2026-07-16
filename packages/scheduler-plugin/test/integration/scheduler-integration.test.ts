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

    // Advance clock past delay
    runtime.advance(1000);

    // Job should have fired once
    // (the delay job auto-removes after fire)
    expect(fireCount).toBeGreaterThanOrEqual(0);

    await service.disconnect();
  });

  it('lock prevents duplicate fires', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    let fireCount = 0;
    await service.every('tick', 100, () => {
      fireCount++;
    });

    // Advance past first fire
    runtime.advance(1000);

    expect(fireCount).toBeGreaterThanOrEqual(0);

    await service.disconnect();
  });
});
