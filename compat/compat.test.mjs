// deno-lint-ignore-file no-console -- harness output is the report (AI_GUIDELINES §11.6).
/**
 * Node/Bun compatibility suite.
 *
 * Consumes the PUBLISHED packages through JSR's npm compatibility layer, which
 * is the only way these runtimes can consume this repo: cross-package
 * specifiers are `jsr:@hono-enterprise/*` and optional heavy deps are `npm:*`,
 * neither of which Node or Bun resolves from the working tree. JSR rewrites
 * both at publish time, so the published artifact is the unit under test
 * (AI_GUIDELINES §4.5, §6.4).
 *
 * Run with `node compat.test.mjs` or `bun compat.test.mjs`. Exits non-zero on
 * the first failed check.
 */
import { createServer } from 'node:net';

import { CAPABILITIES } from '@jsr/hono-enterprise__common';
import { createApplication } from '@jsr/hono-enterprise__kernel';
import { detectRuntime, RuntimePlugin } from '@jsr/hono-enterprise__runtime';
import { LoggerPlugin } from '@jsr/hono-enterprise__logger-plugin';

/** The runtime this process is executing on, as the framework should see it. */
const host = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';

let failures = 0;

/**
 * Records one named check.
 *
 * @param {string} label What the check proves.
 * @param {boolean} passed Whether it held.
 * @param {string} [detail] Observed value, printed on failure.
 */
function check(label, passed, detail) {
  if (passed) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/**
 * Reserves a free TCP port by binding one and releasing it. Node's `@std/net`
 * equivalent is Deno-only, so the compat harness finds its own.
 *
 * @returns {Promise<number>} A port that was free a moment ago.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('could not determine an ephemeral port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/**
 * Attempts to bind a port, then releases it again.
 *
 * @param {number} target The port to claim.
 * @returns {Promise<string | null>} `null` when the bind succeeded, otherwise
 * the error code that refused it (`EADDRINUSE` when a listener still holds it).
 */
function rebind(target) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.on('error', (error) => resolve(error.code ?? error.message));
    probe.listen(target, '127.0.0.1', () => probe.close(() => resolve(null)));
  });
}

/** Builds the application under test: kernel + runtime + one real plugin. */
function createCompatApp() {
  const app = createApplication({ plugins: [RuntimePlugin(), LoggerPlugin()] });
  app.router.get('/compat', (ctx) => ctx.response.json({ runtime: host }));
  return app;
}

console.log(`Hono Enterprise compat suite — ${host}`);

// 1. The npm-compat artifact loads and exposes its documented entry points.
check('kernel exports createApplication', typeof createApplication === 'function');
check('runtime exports RuntimePlugin', typeof RuntimePlugin === 'function');
check('logger-plugin exports LoggerPlugin', typeof LoggerPlugin === 'function');
check('common exports the capability tokens', CAPABILITIES.LOGGER === 'logger');

// 2. Runtime detection agrees with the process actually running the suite. A
//    regression here silently routes every runtime service to the wrong
//    implementation, which no Deno-hosted test can observe.
const detected = detectRuntime();
check(`detectRuntime() reports ${host}`, detected === host, `got ${detected}`);

const app = createCompatApp();
const port = await freePort();
await app.start({ port });

try {
  // 3. Plugins register and their capability resolves across the package
  //    boundary — the token-to-service binding survives the npm rewrite.
  const runtime = app.services.get(CAPABILITIES.RUNTIME);
  check(
    `resolved runtime service reports ${host}`,
    runtime.platform() === host,
    `got ${runtime.platform()}`,
  );

  const logger = app.services.get(CAPABILITIES.LOGGER);
  check('resolved logger service exposes info()', typeof logger?.info === 'function');

  // 4. The in-process pipeline serves a request.
  const injected = await app.inject({ method: 'GET', url: 'http://compat.test/compat' });
  check(
    'inject() serves the route',
    injected.statusCode === 200 && injected.body === `{"runtime":"${host}"}`,
    `got ${injected.statusCode} ${injected.body}`,
  );

  // 5. The HTTP adapter binds a real socket and answers a real request. This is
  //    the check that needs a live runtime: NodeHttpAdapter and BunHttpAdapter
  //    are separate implementations selected by detection, and neither one runs
  //    under the Deno test suite.
  const response = await fetch(`http://127.0.0.1:${port}/compat`);
  const body = await response.text();
  check(
    'HTTP adapter serves the route over a real socket',
    response.status === 200 && body === `{"runtime":"${host}"}`,
    `got ${response.status} ${body}`,
  );
} finally {
  await app.stop();
}

// 6. stop() releases the port, so a redeploy on the same port is not blocked.
//    Binding it again is the only observation that distinguishes a closed
//    listener from one the adapter merely stopped routing to.
const rebound = await rebind(port);
check('stop() releases the listening port', rebound === null, rebound ?? undefined);

console.log(failures === 0 ? `\nAll checks passed (${host}).` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
