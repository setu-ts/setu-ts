import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSetJsrMetadata } from '../../scripts/set-jsr-metadata.ts';
import { jsrSunsetDescription } from '../../scripts/jsr-sunset.ts';
import type { PackageMetadata } from '../../scripts/jsr-metadata.ts';

const metadata: Readonly<Record<string, PackageMetadata>> = {
  kernel: { description: 'Kernel.', runtimeCompat: { node: true } },
};
const description = jsrSunsetDescription('kernel', 'Kernel.');
const published = ['packages/kernel'];
const names = ['kernel'];
const log = vi.fn();
const error = vi.fn();
const env = { JSR_TOKEN: 'offline-fixture', JSR_API_BASE: 'http://stub.invalid' };

describe('JSR metadata offline update', () => {
  beforeEach(() => {
    log.mockClear();
    error.mockClear();
    vi.spyOn(console, 'log').mockImplementation(log);
    vi.spyOn(console, 'error').mockImplementation(error);
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses a missing token before sending any request', async () => {
    const request = vi.fn<typeof fetch>();
    expect(await runSetJsrMetadata([], {}, request)).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });
  it('dry-runs the frozen real inventory with all runtime flag variants', async () => {
    expect(await runSetJsrMetadata(['--dry-run'])).toBe(0);
    const request = vi.fn<typeof fetch>();
    expect(await runSetJsrMetadata(['--dry-run'], {}, request, published, metadata, names)).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(description));
  });
  it('refuses an unknown JSR name and inconsistent authored metadata', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(runSetJsrMetadata([], env, request, [], {}, names)).rejects.toThrow(
      'absent from PUBLISHED_PACKAGES',
    );
    expect(await runSetJsrMetadata([], env, request, published, {}, names)).toBe(1);
    expect(await runSetJsrMetadata([], env, request, [], metadata, [])).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });
  it('skips a package whose sunset description and compat already match', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ description, runtimeCompat: { node: true } }));
    expect(await runSetJsrMetadata([], env, request, published, metadata, names)).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('PATCHes the description and flags separately after an unreadable GET', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect(await runSetJsrMetadata([], env, request, published, metadata, names)).toBe(0);
    expect(request.mock.calls.map(([, init]) => init?.body)).toEqual([
      undefined,
      JSON.stringify({ description }),
      JSON.stringify({ runtimeCompat: { node: true } }),
    ]);
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({
      Authorization: 'Bearer offline-fixture',
      'Content-Type': 'application/json',
    });
  });
  it.each(['description', 'compat'])('updates only the stale %s field', async (field) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          description: field === 'description' ? 'Old.' : description,
          runtimeCompat: { node: field === 'description' },
        }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect(await runSetJsrMetadata([], env, request, published, metadata, names)).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([1, 2])('reports PATCH failure at field %s and can resume later', async (field) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 }));
    if (field === 2) request.mockResolvedValueOnce(new Response(null, { status: 204 }));
    request.mockResolvedValueOnce(new Response('refused', { status: 403 }));
    expect(await runSetJsrMetadata([], env, request, published, metadata, names)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('403 refused'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('/settings'));
  });
  it('propagates a transport failure', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(runSetJsrMetadata([], env, request, published, metadata, names)).rejects.toThrow(
      'offline',
    );
  });
});
