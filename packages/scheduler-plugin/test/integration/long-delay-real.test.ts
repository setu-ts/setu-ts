import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';

describe('long delay on the real Node runtime', () => {
  it('does not fire delay(30 days) during the first 200 ms', async () => {
    const runtime = createNodeRuntimeServices();
    const service = new SchedulerService(runtime, new MemoryLock(runtime));
    await service.connect();
    let calls = 0;
    try {
      await service.delay('real-long-delay', 30 * 24 * 60 * 60 * 1000, () => {
        calls++;
      });
      await new Promise<void>((resolve) => {
        runtime.setTimeout(resolve, 200);
      });
      expect(calls).toBe(0);
    } finally {
      await service.disconnect();
    }
  });
});
