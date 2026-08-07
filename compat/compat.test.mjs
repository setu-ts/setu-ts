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
import { readFileSync } from 'node:fs';

import { CAPABILITIES } from '@jsr/hono-enterprise__common';
import { createApplication } from '@jsr/hono-enterprise__kernel';
import { detectRuntime, RuntimePlugin } from '@jsr/hono-enterprise__runtime';
import { LoggerPlugin } from '@jsr/hono-enterprise__logger-plugin';

/** The runtime this process is executing on, as the framework should see it. */
const host = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';

/**
 * Workspace members deliberately absent from `package.json`, by JSR npm name.
 *
 * A package belongs here only between its introduction and its FIRST publish —
 * it cannot be installed before it exists on the registry, and demanding it
 * would deadlock the milestone PR that introduces it. Remove the entry once the
 * package ships. Anything else missing is a coverage hole and fails check 1.
 */
const PENDING_FIRST_PUBLISH = [];

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

/**
 * Reads the Deno workspace and returns every member's JSR npm package name.
 *
 * The workspace is the authority on what the framework ships, so the compat
 * suite derives its expected surface from it rather than from its own
 * `package.json` — otherwise a new package could be added to the repo and
 * silently never checked on Node or Bun.
 *
 * @returns {string[]} Sorted `@jsr/hono-enterprise__*` names.
 */
function workspacePackageNames() {
  const root = JSON.parse(readFileSync('../deno.json', 'utf8'));
  return root.workspace
    .map((entry) => JSON.parse(readFileSync(`../${entry.replace(/^\.\//, '')}/deno.json`, 'utf8')))
    .map((cfg) => cfg.name.replace('@hono-enterprise/', '@jsr/hono-enterprise__'))
    .sort();
}

/** Builds the application under test: kernel + runtime + one real plugin. */
function createCompatApp() {
  const app = createApplication({ plugins: [RuntimePlugin(), LoggerPlugin()] });
  app.router.get('/compat', (ctx) => ctx.response.json({ runtime: host }));
  return app;
}

console.log(`Hono Enterprise compat suite — ${host}`);

// 1. Every workspace member is actually under test. Without this, adding a
//    package to the repo covers it on Deno and nowhere else, and the suite
//    would keep reporting green over a shrinking fraction of the framework.
const expected = workspacePackageNames();
const declared = Object.keys(
  JSON.parse(readFileSync('package.json', 'utf8')).dependencies ?? {},
);
const uncovered = expected.filter(
  (name) => !declared.includes(name) && !PENDING_FIRST_PUBLISH.includes(name),
);
check(
  `all ${expected.length} workspace packages are declared`,
  uncovered.length === 0,
  `missing: ${uncovered.join(', ')}`,
);

// 2. Each one loads through the npm-compat artifact and exposes a surface. A
//    package whose ESM output or transitive dependency does not resolve on this
//    runtime fails here — the failure the Deno suite structurally cannot see.
const failedToLoad = [];
for (const name of declared) {
  try {
    const module = await import(name);
    if (Object.keys(module).length === 0) failedToLoad.push(`${name} (no exports)`);
  } catch (error) {
    failedToLoad.push(`${name} (${String(error.message).split('\n')[0].slice(0, 90)})`);
  }
}
check(
  `all ${declared.length} packages import and expose a surface`,
  failedToLoad.length === 0,
  failedToLoad.join('; '),
);

// 3. The entry points this suite drives directly are the documented shapes.
check('kernel exports createApplication', typeof createApplication === 'function');
check('runtime exports RuntimePlugin', typeof RuntimePlugin === 'function');
check('logger-plugin exports LoggerPlugin', typeof LoggerPlugin === 'function');
check('common exports the capability tokens', CAPABILITIES.LOGGER === 'logger');

// 4. Runtime detection agrees with the process actually running the suite. A
//    regression here silently routes every runtime service to the wrong
//    implementation, which no Deno-hosted test can observe.
const detected = detectRuntime();
check(`detectRuntime() reports ${host}`, detected === host, `got ${detected}`);

const app = createCompatApp();
const port = await freePort();
await app.start({ port });

try {
  // 5. Plugins register and their capability resolves across the package
  //    boundary — the token-to-service binding survives the npm rewrite.
  const runtime = app.services.get(CAPABILITIES.RUNTIME);
  check(
    `resolved runtime service reports ${host}`,
    runtime.platform() === host,
    `got ${runtime.platform()}`,
  );

  const logger = app.services.get(CAPABILITIES.LOGGER);
  check('resolved logger service exposes info()', typeof logger?.info === 'function');

  // 6. The in-process pipeline serves a request.
  const injected = await app.inject({ method: 'GET', url: 'http://compat.test/compat' });
  check(
    'inject() serves the route',
    injected.statusCode === 200 && injected.body === `{"runtime":"${host}"}`,
    `got ${injected.statusCode} ${injected.body}`,
  );

  // 7. The HTTP adapter binds a real socket and answers a real request. This is
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

// 8. stop() releases the port, so a redeploy on the same port is not blocked.
//    Binding it again is the only observation that distinguishes a closed
//    listener from one the adapter merely stopped routing to.
const rebound = await rebind(port);
check('stop() releases the listening port', rebound === null, rebound ?? undefined);

console.log(failures === 0 ? `\nAll checks passed (${host}).` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
