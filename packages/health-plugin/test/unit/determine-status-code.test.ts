/**
 * Tests for determineStatusCode function.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { determineStatusCode } from '../../src/plugin/health-plugin.ts';
import type { HealthReport } from '@hono-enterprise/common';

describe('determineStatusCode', () => {
  describe('checkLive method', () => {
    it('should return 200 for checkLive when status is up', () => {
      const report: HealthReport = {
        status: 'up',
        timestamp: new Date().toISOString(),
        checks: {},
      };

      const statusCode = determineStatusCode(report, 'checkLive');

      expect(statusCode).toBe(200);
    });
  });

  describe('checkReady method', () => {
    it('should return 200 for checkReady when status is up', () => {
      const report: HealthReport = {
        status: 'up',
        timestamp: new Date().toISOString(),
        checks: {},
      };

      const statusCode = determineStatusCode(report, 'checkReady');

      expect(statusCode).toBe(200);
    });

    it('should return 503 for checkReady when status is degraded', () => {
      const report: HealthReport = {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        checks: {},
      };

      const statusCode = determineStatusCode(report, 'checkReady');

      expect(statusCode).toBe(503);
    });

    it('should return 503 for checkReady when status is down', () => {
      const report: HealthReport = {
        status: 'down',
        timestamp: new Date().toISOString(),
        checks: {},
      };

      const statusCode = determineStatusCode(report, 'checkReady');

      expect(statusCode).toBe(503);
    });
  });

  describe('check method', () => {
    it('should return 200 for check when status is up', () => {
      const report: HealthReport = {
        status: 'up',
        timestamp: new Date().toISOString(),
        checks: {},
      };

      const statusCode = determineStatusCode(report, 'check');

      expect(statusCode).toBe(200);
    });

    it('should return 200 for check when status is degraded', () => {
      const report: HealthReport = {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        checks: {},
      };

      const statusCode = determineStatusCode(report, 'check');

      expect(statusCode).toBe(200);
    });

    it('should return 503 for check when status is down', () => {
      const report: HealthReport = {
        status: 'down',
        timestamp: new Date().toISOString(),
        checks: {},
      };

      const statusCode = determineStatusCode(report, 'check');

      expect(statusCode).toBe(503);
    });
  });
});
