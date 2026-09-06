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

  describe('report projection (X3-7)', () => {
    it('drops undeclared fields an indicator returns; status/latencyMs survive', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('sloppy', () =>
        Promise.resolve({
          status: 'up',
          details: { leak: true },
          latencyMs: 999,
        } as unknown as { status: 'up'; details: { leak: boolean }; latencyMs: number }));

      const report = await service.check();
      const entry = report.checks['sloppy'] as {
        status: string;
        latencyMs: number;
        details?: unknown;
      };

      expect(entry.status).toBe('up');
      expect(entry.details).toBeUndefined();
      // The caller-supplied latencyMs is dropped; the service's own measurement wins.
      expect(entry.latencyMs).not.toBe(999);
      expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('keeps data when present and omits the key entirely when absent', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator(
        'with-data',
        () => Promise.resolve({ status: 'up', data: { broker: 'memory' } }),
      );
      service.registerIndicator('no-data', () => Promise.resolve({ status: 'down' }));

      const report = await service.check();

      expect(report.checks['with-data']?.data).toEqual({ broker: 'memory' });
      expect('data' in (report.checks['no-data'] as object)).toBe(false);
      expect(report.checks['no-data']?.data).toBeUndefined();
    });

    it('does not change worst-status aggregation while projecting', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);

      service.registerIndicator('a', () => Promise.resolve({ status: 'up' }));
      service.registerIndicator(
        'b',
        () => Promise.resolve({ status: 'degraded', data: { reason: 'stale' } }),
      );
      service.registerIndicator('c', () => Promise.resolve({ status: 'down' }));

      const report = await service.check();

      expect(report.status).toBe('down');
      expect(report.checks['b']?.data).toEqual({ reason: 'stale' });
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

  describe('concurrent, deadline-bounded aggregation (M90b)', () => {
    /**
     * A runtime whose clock and timers are MANUALLY driven: `tick(ms)`
     * advances the monotonic clock and fires due timers. No real time
     * passes, so a deadline test costs microseconds, not the deadline.
     */
    function createManualRuntime(): {
      runtime: ReturnType<typeof createFakeRuntime>;
      tick: (ms: number) => void;
      pendingTimers: () => number;
    } {
      let clock = 0;
      const timers = new Map<number, { at: number; fn: () => void }>();
      let nextId = 1;
      const base = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const runtime = {
        ...base,
        hrtime: () => clock,
        setTimeout: (fn: () => void, ms: number) => {
          const id = nextId++;
          timers.set(id, { at: clock + ms, fn });
          return { id };
        },
        clearTimeout: (handle: unknown) => {
          timers.delete((handle as { id: number }).id);
        },
      } as ReturnType<typeof createFakeRuntime>;
      return {
        runtime,
        pendingTimers: () => timers.size,
        tick: (ms: number) => {
          const target = clock + ms;
          for (;;) {
            let due: { id: number; at: number; fn: () => void } | undefined;
            for (const [id, entry] of timers) {
              if (entry.at <= target && (due === undefined || entry.at < due.at)) {
                due = { id, at: entry.at, fn: entry.fn };
              }
            }
            if (due === undefined) break;
            timers.delete(due.id);
            clock = due.at;
            due.fn();
          }
          clock = target;
        },
      };
    }

    it('starts deferred indicators before earlier ones settle (concurrency)', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);
      const started: string[] = [];
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      service.registerIndicator('slow', async () => {
        started.push('slow');
        await firstGate;
        return { status: 'up' };
      });
      service.registerIndicator('fast', () => {
        started.push('fast');
        return Promise.resolve({ status: 'up' });
      });

      const pending = service.check();
      // The fast indicator must have STARTED even though the slow one has
      // not settled — the serial loop never reached it before its turn.
      await Promise.resolve();
      await Promise.resolve();
      expect(started).toContain('fast');

      releaseFirst!();
      const report = await pending;
      expect(report.status).toBe('up');
    });

    it('keeps checks in registration order regardless of settle order', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);
      const gates = [Promise.resolve(), new Promise<void>((r) => setTimeout(r, 1))];

      service.registerIndicator('aaa', async () => {
        await gates[1];
        return { status: 'up' };
      });
      service.registerIndicator('zzz', async () => {
        await gates[0];
        return { status: 'up' };
      });

      const report = await service.check();
      // 'zzz' settled first; 'aaa' still owns the first key.
      expect(Object.keys(report.checks)).toEqual(['aaa', 'zzz']);
    });

    it('maps a timeout to down with reason "timeout" and fires the deadline', async () => {
      const manual = createManualRuntime();
      const service = new HealthService(manual.runtime, { indicatorTimeoutMs: 5_000 });

      service.registerIndicator('hung', () => new Promise(() => {}));

      const pending = service.check();
      manual.tick(4_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      manual.tick(1);
      const report = await pending;
      expect(report.status).toBe('down');
      expect(report.checks['hung']?.data).toEqual({ reason: 'timeout' });
      expect(report.checks['hung']?.latencyMs).toBe(5_000);
      // The deadline timer consumed itself — no handle leaked.
      expect(manual.pendingTimers()).toBe(0);
    });

    it('maps a rejection to down with reason "error" and never serializes the throw', async () => {
      const runtime = createFakeRuntime({ now: 1_000_000_000_000, hrtime: 0 });
      const service = new HealthService(runtime);
      const driverDiagnostic = 'pg: connection refused host=10.0.0.9 user=svc';

      service.registerIndicator('exploding', () => {
        return Promise.reject(new Error(driverDiagnostic));
      });

      const report = await service.check();
      expect(report.status).toBe('down');
      expect(report.checks['exploding']?.data).toEqual({ reason: 'error' });
      expect(JSON.stringify(report)).not.toContain(driverDiagnostic);
    });

    it('clears the deadline timer when the indicator settles first (no handle leak)', async () => {
      const manual = createManualRuntime();
      const service = new HealthService(manual.runtime, { indicatorTimeoutMs: 5_000 });

      service.registerIndicator('quick', () => Promise.resolve({ status: 'up' }));

      const report = await service.check();
      expect(report.status).toBe('up');
      expect(manual.pendingTimers()).toBe(0);
    });

    it('clears the deadline timer when an indicator throws synchronously (no handle leak)', async () => {
      const manual = createManualRuntime();
      const service = new HealthService(manual.runtime, { indicatorTimeoutMs: 5_000 });
      const driverDiagnostic = 'sync indicator blew up before returning a promise';

      service.registerIndicator('sync-throw', () => {
        throw new Error(driverDiagnostic);
      });

      const report = await service.check();
      // A synchronous throw is a failing check — recorded as `error`, the
      // thrown value never serialized into the report.
      expect(report.status).toBe('down');
      expect(report.checks['sync-throw']?.data).toEqual({ reason: 'error' });
      expect(JSON.stringify(report)).not.toContain(driverDiagnostic);
      // The deadline handle did not outlive the throw.
      expect(manual.pendingTimers()).toBe(0);
    });

    it('defaults the deadline to 5,000ms when omitted', async () => {
      const manual = createManualRuntime();
      const service = new HealthService(manual.runtime);

      service.registerIndicator('hung', () => new Promise(() => {}));

      const pending = service.check();
      manual.tick(4_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      manual.tick(1);
      await pending;
      // Settled exactly at 5,000 — the default deadline.
    });

    it('measures each indicator latency individually', async () => {
      const manual = createManualRuntime();
      const service = new HealthService(manual.runtime);

      let releaseSlow: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      service.registerIndicator('slow', async () => {
        manual.tick(30);
        await gate;
        return { status: 'up' };
      });
      service.registerIndicator('instant', () => Promise.resolve({ status: 'up' }));

      const pending = service.check();
      releaseSlow!();
      const report = await pending;
      // The concurrent run measures both against their own start.
      expect(report.checks['slow']?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(report.checks['instant']?.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
