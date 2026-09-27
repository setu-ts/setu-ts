/**
 * Holds the generated middleware's priority comment to what the framework registers.
 *
 * `setu generate middleware` writes a comment telling the developer where the
 * framework's own middleware sits, so they can pick a priority. Every number in it
 * belongs to ANOTHER package, kept in a module-private constant, so the comment can
 * drift silently — and its first version did: it omitted tenant resolution at 40 and
 * request logging at 100. The table it renders from is data, and this file boots each
 * owning plugin in a real kernel application and reads the priorities it actually
 * registered from the kernel's diagnostics snapshot.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';
import { FRAMEWORK_MIDDLEWARE_BANDS, generateMiddleware } from '../../src/schematics/middleware.ts';
import { REST_MIDDLEWARE } from '../../src/templates/rest.ts';
import { deriveNames } from '../../src/utils/names.ts';

/**
 * Boots the plugins and returns the priority of every global middleware registered.
 *
 * @param plugins - The plugins under test, beside the runtime
 * @returns The priorities, ascending
 */
async function registeredPriorities(plugins: readonly IPlugin[]): Promise<number[]> {
  const app = createApplication({ plugins: [RuntimePlugin(), ...plugins], diagnostics: {} });
  await app.start();
  try {
    return app.diagnostics!.snapshot().nodes
      .filter((node) => node.kind === 'middleware')
      .map((node) => node.priority!)
      .sort((left, right) => left - right);
  } finally {
    await app.stop();
  }
}

/**
 * The band the table names for an owner.
 *
 * @param owner - The owner string exactly as the table spells it
 * @returns The band
 */
function band(owner: string): { readonly from: number; readonly to: number } {
  const found = FRAMEWORK_MIDDLEWARE_BANDS.find((entry) => entry.owner === owner);
  if (found === undefined) throw new Error(`No band owned by '${owner}'.`);
  return found;
}

/**
 * Which plugins own each band. Keyed by the table's own owner strings, so a band
 * added to the table without a composition here fails the completeness case below.
 */
const COMPOSITIONS: Readonly<Record<string, () => readonly IPlugin[]>> = {
  metrics: () => [MetricsPlugin()],
  telemetry: () => [TelemetryPlugin()],
  'tenant resolution': () => [MultiTenancyPlugin({ resolver: 'header' })],
  'request logging': () => [LoggerPlugin({ requestLogging: true })],
  // Every optional concern switched on, so the band's ends are both observed.
  'HTTP security, session and form CSRF': () => [
    HttpSecurityPlugin({
      cors: { origin: ['https://example.test'] },
      csrf: {},
      requestSize: {},
      ipSecurity: {},
    }),
    SessionPlugin({ secret: 'a-test-secret-that-is-at-least-32-bytes-long', csrf: {} }),
  ],
};

describe('the generated middleware priority comment', () => {
  it('names a composition for every plugin-owned band', () => {
    const owners = FRAMEWORK_MIDDLEWARE_BANDS.map((entry) => entry.owner)
      .filter((owner) => owner !== 'error handler');
    expect(Object.keys(COMPOSITIONS).sort()).toEqual([...owners].sort());
  });

  for (const [owner, plugins] of Object.entries(COMPOSITIONS)) {
    it(`matches what the ${owner} plugins register`, async () => {
      const priorities = await registeredPriorities(plugins());
      const { from, to } = band(owner);
      expect(priorities.length).toBeGreaterThan(0);
      // Both ends observed, so the band is neither too wide nor stale…
      expect(priorities[0]).toBe(from);
      expect(priorities[priorities.length - 1]).toBe(to);
      // …and nothing registered outside it.
      for (const priority of priorities) {
        expect(priority >= from && priority <= to).toBe(true);
      }
    });
  }

  // The one band no plugin owns: the templates add the error handler themselves.
  it('matches where the templates add the error handler', () => {
    const errorHandler = REST_MIDDLEWARE.find((wiring) => wiring.symbol === 'errorHandler');
    expect(errorHandler?.addOptions.priority).toBe(band('error handler').from);
  });

  it('renders every band into the generated file', () => {
    const [file] = generateMiddleware(deriveNames('audit'), {
      runtime: 'deno',
      plugins: new Set<string>(),
      now: () => 0,
      artifacts: {},
    });
    const prose = file!.contents.replace(/\n \* /g, ' ');
    for (const entry of FRAMEWORK_MIDDLEWARE_BANDS) {
      const at = entry.from === entry.to ? `${entry.from}` : `${entry.from}–${entry.to}`;
      expect(prose).toContain(`${at} (${entry.owner})`);
    }
  });

  // The default a generated middleware starts at must sit inside every framework band,
  // or the comment's advice and the emitted value disagree.
  it('starts a generated middleware inside every framework band', async () => {
    const [file] = generateMiddleware(deriveNames('audit'), {
      runtime: 'deno',
      plugins: new Set<string>(),
      now: () => 0,
      artifacts: {},
    });
    const emitted = Number(/AUDIT_MIDDLEWARE_PRIORITY = (\d+);/.exec(file!.contents)?.[1]);
    const highest = Math.max(...FRAMEWORK_MIDDLEWARE_BANDS.map((entry) => entry.to));
    expect(emitted).toBeGreaterThan(highest);

    // And the kernel runs it after all of them.
    const plugins = Object.values(COMPOSITIONS).flatMap((compose) => compose());
    const app = createApplication({ plugins: [RuntimePlugin(), ...plugins], diagnostics: {} });
    app.middleware.add((_ctx, next) => next(), { priority: emitted, name: 'generated' });
    await app.start();
    try {
      const middleware = app.diagnostics!.snapshot().nodes
        .filter((node) => node.kind === 'middleware');
      const last = middleware.reduce((max, node) => node.position! > max.position! ? node : max);
      expect(last.priority).toBe(emitted);
    } finally {
      await app.stop();
    }
  });
});
