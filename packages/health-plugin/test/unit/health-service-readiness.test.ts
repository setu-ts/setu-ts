import { describe, expect, it, vi } from 'vitest';
import { HealthService } from '../../src/services/health-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('health readiness membership', () => {
  it('omits opted-out failures from readiness while full health still runs them', async () => {
    const service = new HealthService(createFakeRuntime());
    const excluded = vi.fn(() => Promise.resolve({ status: 'down' as const }));
    service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));
    service.registerIndicator('mail', excluded, { readiness: false });
    service.registerIndicator('default', () => Promise.resolve({ status: 'up' }));
    service.registerIndicator('explicit', () => Promise.resolve({ status: 'up' }), {
      readiness: true,
    });
    const ready = await service.checkReady();
    expect(ready.status).toBe('up');
    expect(Object.keys(ready.checks)).toEqual(['default', 'explicit']);
    expect(excluded).not.toHaveBeenCalled();
    expect((await service.check()).status).toBe('down');
    expect(excluded).toHaveBeenCalledTimes(1);
    expect(Object.keys((await service.checkLive()).checks)).toEqual(['self']);
    expect(excluded).toHaveBeenCalledTimes(1);
  });

  it('reports up when there are no readiness members', async () => {
    const service = new HealthService(createFakeRuntime());
    service.registerIndicator('failure', () => Promise.resolve({ status: 'down' }), {
      readiness: false,
    });
    expect(await service.checkReady()).toMatchObject({ status: 'up', checks: {} });
  });
});
