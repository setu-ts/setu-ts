/**
 * Tests for http-indicator.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createHttpIndicator } from '../../src/indicators/http-indicator.ts';

describe('createHttpIndicator', () => {
  it('should have the provided name', () => {
    const indicator = createHttpIndicator('test-api', { url: 'http://example.com' });

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
    });

    const result = await indicator.check();

    expect(result.status).toBe('up');
    expect(result.data).toEqual({ statusCode: 200 });
  });

  it('should return up on 3xx status', async () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 301,
      } as Response);

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
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
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual(
      expect.objectContaining({
        error: 'Network error',
      }),
    );
  });

  it('should map a TimeoutError to a timeout result', async () => {
    // AbortSignal.timeout aborts with a TimeoutError DOMException.
    const mockFetcher = () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    };

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      timeoutMs: 5000,
      fetcher: mockFetcher,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual({ error: 'timeout' });
  });

  it('should map an AbortError to a timeout result', async () => {
    // A caller-supplied signal or fake may surface an AbortError instead.
    const mockFetcher = () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    };

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual({ error: 'timeout' });
  });

  it('should include error message for non-2xx/3xx status', async () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 404,
      } as Response);

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
    });

    const result = await indicator.check();

    expect(result.status).toBe('down');
    expect(result.data).toEqual({
      statusCode: 404,
      error: 'Unexpected status code: 404',
    });
  });

  it('should use default timeout of 5000ms', () => {
    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
    });

    expect(indicator).toBeDefined();
  });

  it('should use custom timeout when provided', () => {
    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      timeoutMs: 3000,
    });

    expect(indicator).toBeDefined();
  });

  describe('error message handling', () => {
    it('should handle non-Error thrown values', async () => {
      const mockFetcher = () => {
        throw 'string error';
      };

      const indicator = createHttpIndicator('test-api', {
        url: 'http://example.com',
        fetcher: mockFetcher,
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
      });

      const result = await indicator.check();

      expect(result.status).toBe('down');
      expect(result.data?.error).toBe('custom message');
    });
  });
});
