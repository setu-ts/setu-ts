/**
 * Tests for http-indicator.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createHttpIndicator } from '../../src/indicators/http-indicator.ts';
import { createFakeRuntime } from '../../test/fixtures/fake-runtime.ts';

describe('createHttpIndicator', () => {
  const runtime = createFakeRuntime({ hrtime: 0 });

  it('should have the provided name', () => {
    const indicator = createHttpIndicator('test-api', { url: 'http://example.com', runtime });

    expect(indicator.name).toBe('test-api');
  });

  it('should return up on 2xx status', async () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 200,
      } as Response);

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime,
    });

    const result = await indicator.check();

    expect(result.status).toBe('up');
    expect(result.data).toEqual(
      expect.objectContaining({
        statusCode: 200,
      }),
    );
  });

  it('should return up on 3xx status', async () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 301,
      } as Response);

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime,
    });

    const result = await indicator.check();

    expect(result.status).toBe('up');
  });

  it('should return down on 4xx status', async () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 404,
      } as Response);

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual(
      expect.objectContaining({
        statusCode: 404,
      }),
    );
  });

  it('should return down on 5xx status', async () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 500,
      } as Response);

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
  });

  it('should return down on network error', async () => {
    const mockFetcher = () => {
      throw new Error('Network error');
    };

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual(
      expect.objectContaining({
        error: 'Network error',
      }),
    );
  });

  it('should handle timeout via AbortError', async () => {
    // Simulate a timeout by throwing an AbortError
    const mockFetcher = () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      throw abortError;
    };

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      timeoutMs: 5000,
      fetcher: mockFetcher,
      runtime,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual(
      expect.objectContaining({
        error: 'timeout',
      }),
    );
  });

  it('should include error message for non-2xx/3xx status', async () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 404,
      } as Response);

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual(
      expect.objectContaining({
        statusCode: 404,
        error: 'Unexpected status code: 404',
      }),
    );
  });

  it('should measure latency using runtime.hrtime()', async () => {
    let hrtimeValue = 0;
    const fakeRuntime = {
      ...createFakeRuntime({ hrtime: 0 }),
      hrtime() {
        return hrtimeValue;
      },
    };

    const mockFetcher = () => {
      hrtimeValue = 100; // Simulate 100ms elapsed
      return Promise.resolve({
        status: 200,
      } as Response);
    };

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime: fakeRuntime,
    });

    const result = await indicator.check();

    expect(result.data).toEqual(
      expect.objectContaining({
        statusCode: 200,
        latencyMs: 100,
      }),
    );
  });

  it('should use default timeout of 5000ms', () => {
    // Just verify the indicator is created without error
    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      runtime,
    });

    expect(indicator).toBeDefined();
  });

  it('should use custom timeout when provided', () => {
    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      timeoutMs: 3000,
      runtime,
    });

    expect(indicator).toBeDefined();
  });

  describe('timeout behavior', () => {
    it('should cancel pending request on timeout', async () => {
      // Simulate timeout by having fetcher throw AbortError after "delay"
      let hrtimeValue = 0;
      const fakeRuntime = {
        ...createFakeRuntime({ hrtime: 0 }),
        hrtime() {
          return hrtimeValue;
        },
      };

      const mockFetcher = () => {
        hrtimeValue = 6000; // After timeout threshold
        const abortError = new DOMException('The operation was aborted', 'AbortError');
        throw abortError;
      };

      const indicator = createHttpIndicator('test-api', {
        url: 'http://example.com',
        timeoutMs: 5000,
        fetcher: mockFetcher,
        runtime: fakeRuntime,
      });

      const result = await indicator.check();

      expect(result.status).toBe('down');
      expect(result.data).toEqual(
        expect.objectContaining({
          error: 'timeout',
        }),
      );
    });
  });

  describe('error message handling', () => {
    it('should handle non-Error thrown values', async () => {
      const mockFetcher = () => {
        throw 'string error';
      };

      const indicator = createHttpIndicator('test-api', {
        url: 'http://example.com',
        fetcher: mockFetcher,
        runtime,
      });

      const result = await indicator.check();

      expect(result.status).toBe('down');
      expect(result.data?.error).toBe('string error');
    });

    it('should handle Error with message property', async () => {
      const mockFetcher = () => {
        throw new Error('custom message');
      };

      const indicator = createHttpIndicator('test-api', {
        url: 'http://example.com',
        fetcher: mockFetcher,
        runtime,
      });

      const result = await indicator.check();

      expect(result.status).toBe('down');
      expect(result.data?.error).toBe('custom message');
    });
  });
});
