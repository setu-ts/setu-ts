/**
 * Unit tests for Cloudflare Workers runtime services.
 *
 * @module
 */

import { createCloudflareRuntimeServices } from '../../src/adapters/workers/cf-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------

describe('cf-runtime | platform', () => {
  it('returns cloudflare-workers', () => {
    const services = createCloudflareRuntimeServices();
    expect(services.platform()).toBe('cloudflare-workers');
  });
});

// ---------------------------------------------------------------------------
// uuid / randomBytes / subtle
// ---------------------------------------------------------------------------

describe('cf-runtime | uuid', () => {
  it('uses crypto.randomUUID', () => {
    const services = createCloudflareRuntimeServices();
    const uuid = services.uuid();
    expect(typeof uuid).toBe('string');
    expect(uuid.length).toBe(36); // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  });
});

describe('cf-runtime | randomBytes', () => {
  it('returns correct length', () => {
    const services = createCloudflareRuntimeServices();
    const bytes = services.randomBytes(32);
    expect(bytes.length).toBe(32);
  });
});

describe('cf-runtime | subtle', () => {
  it('is crypto.subtle', () => {
    const services = createCloudflareRuntimeServices();
    expect(services.subtle).toBeDefined();
    expect(typeof services.subtle.importKey).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// now / hrtime
// ---------------------------------------------------------------------------

describe('cf-runtime | now', () => {
  it('uses Date.now', () => {
    const services = createCloudflareRuntimeServices();
    const now = services.now();
    expect(typeof now).toBe('number');
    expect(now).toBeGreaterThan(0);
  });
});

describe('cf-runtime | hrtime', () => {
  it('uses performance.now', () => {
    const services = createCloudflareRuntimeServices();
    const hr = services.hrtime();
    expect(typeof hr).toBe('number');
    expect(hr).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// timers
// ---------------------------------------------------------------------------

describe('cf-runtime | setTimeout', () => {
  it('works', () => {
    const services = createCloudflareRuntimeServices();
    let fired = false;
    const handle = services.setTimeout(() => {
      fired = true;
    }, 1);
    expect(handle).not.toBeNull();
    services.clearTimeout(handle);
    expect(fired).toBe(false); // cleared before fire
  });
});

describe('cf-runtime | setInterval', () => {
  it('works', () => {
    const services = createCloudflareRuntimeServices();
    const handle = services.setInterval(() => {}, 100);
    expect(handle).not.toBeNull();
    services.clearInterval(handle);
  });
});

// ---------------------------------------------------------------------------
// env injection seam
// ---------------------------------------------------------------------------

describe('cf-runtime | env', () => {
  it('reads from injected env seam', () => {
    const services = createCloudflareRuntimeServices({
      env: { API_KEY: 'secret', DB_HOST: 'localhost' },
    });
    expect(services.env['API_KEY']).toBe('secret');
    expect(services.env['DB_HOST']).toBe('localhost');
  });

  it('defaults to empty record', () => {
    const services = createCloudflareRuntimeServices();
    expect(Object.keys(services.env).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fs is undefined
// ---------------------------------------------------------------------------

describe('cf-runtime | fs', () => {
  it('is undefined', () => {
    const services = createCloudflareRuntimeServices();
    expect(services.fs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// exit throws
// ---------------------------------------------------------------------------

describe('cf-runtime | exit', () => {
  it('throws', () => {
    const services = createCloudflareRuntimeServices();
    expect(() => services.exit(1)).toThrow('Process exit is not supported');
  });
});

// ---------------------------------------------------------------------------
// version / hostname are empty strings
// ---------------------------------------------------------------------------

describe('cf-runtime | version', () => {
  it('returns empty string', () => {
    const services = createCloudflareRuntimeServices();
    expect(services.version()).toBe('');
  });
});

describe('cf-runtime | hostname', () => {
  it('returns empty string', () => {
    const services = createCloudflareRuntimeServices();
    expect(services.hostname()).toBe('');
  });
});
