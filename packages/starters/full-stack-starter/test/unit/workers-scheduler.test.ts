/**
 * @module full-stack-starter Workers scheduler tests
 *
 * `SchedulerPlugin` refuses Cloudflare Workers at `register()`, so a starter
 * that registered it unconditionally could not boot there at all. These tests
 * drive the internal composition with an explicit platform, because the
 * starter's own `detectRuntime()` always answers `'deno'` under this suite.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { composeFullStackPlugins } from '../../src/app.ts';

const names = (plugins: readonly IPlugin[]): string[] => plugins.map((p) => p.name);

/** Replaces the starter's detecting `RuntimePlugin()` with one forced to Workers. */
function onWorkers(plugins: readonly IPlugin[]): IPlugin[] {
  return plugins.map((p) =>
    p.name === 'runtime' ? RuntimePlugin({ platform: 'cloudflare-workers' }) : p
  );
}

describe('full-stack-starter / scheduler on Cloudflare Workers', () => {
  it('leaves the scheduler out on Workers and keeps every other plugin', () => {
    const workers = names(composeFullStackPlugins({}, 'cloudflare-workers'));
    const deno = names(composeFullStackPlugins({}, 'deno'));
    expect(workers).not.toContain('scheduler-plugin');
    expect(workers).toEqual(deno.filter((name) => name !== 'scheduler-plugin'));
  });

  it('registers the scheduler on every server runtime', () => {
    for (const platform of ['deno', 'node', 'bun'] as const) {
      expect(names(composeFullStackPlugins({}, platform))).toContain('scheduler-plugin');
    }
  });

  it('still registers an explicit scheduler arm on Workers', () => {
    const plugins = composeFullStackPlugins({ scheduler: {} }, 'cloudflare-workers');
    expect(names(plugins)).toContain('scheduler-plugin');
  });

  it('boots on Workers and answers /health', async () => {
    const app = createApplication({
      plugins: onWorkers(composeFullStackPlugins({}, 'cloudflare-workers')),
    });
    await app.start();
    try {
      const response = await app.fetch(new Request('http://localhost/health'));
      expect(response.status).toBe(200);
      const body = await response.json() as { checks: Record<string, unknown> };
      expect(Object.keys(body.checks)).not.toContain('scheduler');
    } finally {
      await app.stop();
    }
  });

  it('cannot boot on Workers when the scheduler is registered (the defect)', async () => {
    const app = createApplication({
      plugins: onWorkers(composeFullStackPlugins({ scheduler: {} }, 'cloudflare-workers')),
    });
    await expect(app.start()).rejects.toThrow('SchedulerPlugin cannot run on cloudflare-workers');
  });
});
