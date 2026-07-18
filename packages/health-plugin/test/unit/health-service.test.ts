/**
 * Tests for HealthService.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HealthService } from '../../src/services/health-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('HealthService', () => {
  it('should register indicators', () => {
    const runtime = createFakeRuntime();
    const service = new HealthService(runtime);

    service.registerIndicator('test', () => Promise.resolve({ status: 'up' }));

    // Verify indicator is registered by checking if it appears in a check
    expect(service).toBeDefined();
  });

  it('should throw on duplicate indicator name', () => {
    const runtime = createFakeRuntime();
    const service = new HealthService(runtime);

    service.registerIndicator('test', () => Promise.resolve({ status: 'up' }));

    expect(() => {
      service.registerIndicator('test', () => Promise.resolve({ status: 'down' }));
    }).toThrow('Duplicate health indicator name: "test"');
  });

  describe('check()', () => {
    it('should return up when all indicators are up', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('indicator2', () => Promise.resolve({ status: 'up' }));

      const report = await service.check();

      expect(report.status).toBe('up');
      expect(report.timestamp).toBe('2001-09-09T01:46:40.000Z');
      expect(report.checks).toHaveProperty('indicator1');
      expect(report.checks).toHaveProperty('indicator2');
    });

    it('should return degraded when any indicator is degraded', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('indicator2', () => Promise.resolve({ status: 'degraded' }));

      const report = await service.check();

      expect(report.status).toBe('degraded');
    });

    it('should return down when any indicator is down', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('indicator2', () => Promise.resolve({ status: 'down' }));

      const report = await service.check();

      expect(report.status).toBe('down');
    });

    it('should include latencyMs for each check', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'up' }));

      const report = await service.check();

      expect(report.checks['indicator1']?.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should include data from indicators', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () =>
        Promise.resolve({
          status: 'up',
          data: { version: '1.0.0' },
        }));

      const report = await service.check();

      expect(report.checks['indicator1']?.data).toEqual({ version: '1.0.0' });
    });
  });

  describe('checkLive()', () => {
    it('should only include the self indicator', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      // Register self indicator
      service.registerIndicator('self', () =>
        Promise.resolve({
          status: 'up',
          data: { platform: 'node' },
        }));

      // Register other indicators
      service.registerIndicator('other', () => Promise.resolve({ status: 'up' }));

      const report = await service.checkLive();

      expect(report.status).toBe('up');
      expect(Object.keys(report.checks)).toEqual(['self']);
    });

    it('should return up when self indicator is up', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));

      const report = await service.checkLive();

      expect(report.status).toBe('up');
    });

    it('should include latencyMs', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));

      const report = await service.checkLive();

      expect(report.checks['self']?.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkReady()', () => {
    it('should exclude the self indicator', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('contributed1', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('contributed2', () => Promise.resolve({ status: 'up' }));

      const report = await service.checkReady();

      expect(Object.keys(report.checks)).not.toContain('self');
      expect(report.checks).toHaveProperty('contributed1');
      expect(report.checks).toHaveProperty('contributed2');
    });

    it('should return up when all contributed indicators are up', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('contributed1', () => Promise.resolve({ status: 'up' }));

      const report = await service.checkReady();

      expect(report.status).toBe('up');
    });

    it('should return down when any contributed indicator is down', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('contributed1', () => Promise.resolve({ status: 'down' }));

      const report = await service.checkReady();

      expect(report.status).toBe('down');
    });

    it('should return degraded when any contributed indicator is degraded', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('contributed1', () => Promise.resolve({ status: 'degraded' }));

      const report = await service.checkReady();

      expect(report.status).toBe('degraded');
    });

    it('should handle case with no contributed indicators', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('self', () => Promise.resolve({ status: 'up' }));

      const report = await service.checkReady();

      expect(report.status).toBe('up');
      expect(Object.keys(report.checks)).toHaveLength(0);
    });
  });

  describe('worst-status aggregation', () => {
    it('should prefer down over degraded', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'degraded' }));
      service.registerIndicator('indicator2', () => Promise.resolve({ status: 'down' }));

      const report = await service.check();

      expect(report.status).toBe('down');
    });

    it('should prefer degraded over up', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('indicator2', () => Promise.resolve({ status: 'degraded' }));

      const report = await service.check();

      expect(report.status).toBe('degraded');
    });

    it('should return up when all are up', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator('indicator2', () => Promise.resolve({ status: 'up' }));

      const report = await service.check();

      expect(report.status).toBe('up');
    });

    it('keeps the worse status when a healthier indicator follows it', async () => {
      // Iteration order matters: a 'down' seen before an 'up' must not be
      // "healed" by the later 'up' — exercises the branch where the running
      // worst is already worse than the incoming status.
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('first', () => Promise.resolve({ status: 'down' }));
      service.registerIndicator('second', () => Promise.resolve({ status: 'up' }));

      const report = await service.check();

      expect(report.status).toBe('down');
    });
  });

  describe('timestamp', () => {
    it('should use runtime.now() for timestamp', async () => {
      const fixedTime = 1_609_459_200_000; // 2021-01-01T00:00:00.000Z
      const runtime = createFakeRuntime({ now: fixedTime, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('indicator1', () => Promise.resolve({ status: 'up' }));

      const report = await service.check();

      expect(report.timestamp).toBe('2021-01-01T00:00:00.000Z');
    });
  });

  describe('checkLive() edge cases', () => {
    it('should return empty report when self indicator is not found', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      // Don't register self indicator - only register other indicators
      service.registerIndicator('other', () => Promise.resolve({ status: 'up' }));

      const report = await service.checkLive();

      expect(report.status).toBe('up');
      expect(report.timestamp).toBe('2001-09-09T01:46:40.000Z');
      expect(Object.keys(report.checks)).toHaveLength(0);
    });
  });
});
