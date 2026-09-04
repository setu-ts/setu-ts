/**
 * Regression: an application-authored status that the web `Response`
 * constructor refuses must not turn the error path itself into the fault.
 *
 * `FlagGuardOptions.statusCode` is a PUBLISHED option, so `4004` — a plausible
 * typo for `404` — is authored by application code and reaches
 * `respondWithError` unchecked. Before the guard, every request to that route
 * threw `RangeError: The status provided (4004) is outside the range
 * [200, 599]` out of `app.fetch`.
 *
 * Driven with `app.fetch` and never `inject()`: `inject()` builds no native
 * `Response`, so it cannot observe this at all — the M51 `Allow`-header trap.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createFlagGuard, FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import { HttpError } from '../../src/errors/http-error.ts';

/**
 * An app whose `/typo`, `/nan` and `/sane` routes are each guarded by a flag
 * guard carrying the named status.
 */
async function buildApp(format: 'default' | 'rfc9457'): Promise<IKernelApplication> {
  const app = await createTestApp({
    plugins: [
      RuntimePlugin(),
      FeatureFlagsPlugin({
        provider: 'memory',
        options: { flags: { 'off-flag': { enabled: false } } },
      }),
    ],
    autoStart: false,
  });
  app.middleware.add(errorHandler({ format, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  const guards: ReadonlyArray<readonly [string, number]> = [
    ['/typo', 4004],
    ['/nan', Number.NaN],
    ['/huge', 999],
    ['/sane', 404],
  ];
  let priority = 100;
  for (const [path, statusCode] of guards) {
    const guard = createFlagGuard('off-flag', { statusCode });
    app.middleware.add(
      (ctx, next) => (ctx.request.path === path ? guard(ctx, next) : next()),
      { priority: priority++, name: `guard${path}` },
    );
    app.router.get(path, (ctx) => ctx.response.text('handler ran'));
  }
  await app.start();
  return app;
}

/** Drives a path through the REAL serve path and reads status + body. */
async function drive(app: IKernelApplication, path: string) {
  const res = await app.fetch(new Request(`http://test.local${path}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('an unserveable status on a published guard option', () => {
  it('answers 500 instead of throwing RangeError out of app.fetch (default format)', async () => {
    const app = await buildApp('default');
    try {
      // Each of these threw before the guard existed.
      for (const path of ['/typo', '/nan', '/huge']) {
        const res = await drive(app, path);
        expect(res.status).toBe(500);
        // The body's own status member agrees with the written status.
        expect(res.body.statusCode).toBe(500);
      }
    } finally {
      await app.stop();
    }
  });

  it('leaves a serveable status untouched', async () => {
    const app = await buildApp('default');
    try {
      const res = await drive(app, '/sane');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ statusCode: 404, message: 'Not Found' });
    } finally {
      await app.stop();
    }
  });

  it("keeps the formatted body's status member in agreement with the written status", async () => {
    const app = await buildApp('rfc9457');
    try {
      const res = await drive(app, '/typo');
      expect(res.status).toBe(500);
      // The Problem Details `status` member is built from the same sanitized
      // init, so body and header cannot disagree.
      expect(res.body.status).toBe(500);
      const sane = await drive(app, '/sane');
      expect(sane.status).toBe(404);
      expect(sane.body.status).toBe(404);
    } finally {
      await app.stop();
    }
  });

  it('never runs the guarded handler — the route is still refused, just serveably', async () => {
    const app = await buildApp('default');
    try {
      const res = await app.fetch(new Request('http://test.local/typo'));
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('handler ran');
    } finally {
      await app.stop();
    }
  });
});

describe('an unserveable status on a thrown HttpError', () => {
  /**
   * `HttpError`'s constructor validates nothing — its own JSDoc says the
   * factory functions are what guarantee a correct status — so this is a
   * SECOND door to the identical crash, reached without `respondWithError`.
   */
  async function throwingApp(format: 'default' | 'rfc9457'): Promise<IKernelApplication> {
    const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
    app.middleware.add(errorHandler({ format, logErrors: false }), {
      priority: 0,
      name: 'error-handler',
    });
    app.router.get('/typo', () => {
      throw new HttpError(4004, 'typo');
    });
    app.router.get('/nan', () => {
      throw new HttpError(Number.NaN, 'nan');
    });
    app.router.get('/sane', () => {
      throw new HttpError(404, 'genuinely missing');
    });
    await app.start();
    return app;
  }

  it('answers 500 instead of throwing RangeError out of the handler catch', async () => {
    const app = await throwingApp('default');
    try {
      const typo = await drive(app, '/typo');
      expect(typo.status).toBe(500);
      // The status is clamped; only the number was wrong, so the message the
      // thrower deliberately wrote survives.
      expect(typo.body).toEqual({ statusCode: 500, message: 'typo' });
      expect((await drive(app, '/nan')).status).toBe(500);
    } finally {
      await app.stop();
    }
  });

  it('leaves a serveable thrown status untouched', async () => {
    const app = await throwingApp('default');
    try {
      const res = await drive(app, '/sane');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ statusCode: 404, message: 'genuinely missing' });
    } finally {
      await app.stop();
    }
  });

  it('keeps the Problem Details status member in agreement with the written status', async () => {
    const app = await throwingApp('rfc9457');
    try {
      const res = await drive(app, '/typo');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe(500);
    } finally {
      await app.stop();
    }
  });
});
