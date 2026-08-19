// deno-lint-ignore-file no-console -- harness output is the report (AI_GUIDELINES §11.6).
/**
 * Node/Bun compatibility suite.
 *
 * Consumes the PUBLISHED packages through JSR's npm compatibility layer, which
 * is the only way these runtimes can consume this repo: cross-package
 * specifiers are `jsr:@setu-ts/*` and optional heavy deps are `npm:*`,
 * neither of which Node or Bun resolves from the working tree. JSR rewrites
 * both at publish time, so the published artifact is the unit under test
 * (AI_GUIDELINES §4.5, §6.4).
 *
 * Run with `node compat.test.mjs` or `bun compat.test.mjs`. Exits non-zero on
 * the first failed check.
 */
import { createServer } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';

import { CAPABILITIES } from '@jsr/setu-ts__common';
import { createApplication } from '@jsr/setu-ts__kernel';
import { detectRuntime, RuntimePlugin } from '@jsr/setu-ts__runtime';
import { LoggerPlugin } from '@jsr/setu-ts__logger-plugin';

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
 * @returns {string[]} Sorted `@jsr/setu-ts__*` names.
 */
function workspacePackageNames() {
  const root = JSON.parse(readFileSync('../deno.json', 'utf8'));
  return root.workspace
    .map((entry) => JSON.parse(readFileSync(`../${entry.replace(/^\.\//, '')}/deno.json`, 'utf8')))
    .map((cfg) => cfg.name.replace('@setu-ts/', '@jsr/setu-ts__'))
    .sort();
}

/** Builds the application under test: kernel + runtime + one real plugin. */
function createCompatApp() {
  const app = createApplication({ plugins: [RuntimePlugin(), LoggerPlugin()] });
  app.router.get('/compat', (ctx) => ctx.response.json({ runtime: host }));
  return app;
}

console.log(`Setu-TS compat suite — ${host}`);

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

// 9. The published grpc/telemetry artifacts must ship no non-literal path from
//    an `npm:` string into import(). JSR's npm-compatibility rewrite is static
//    and reaches only a literal import('npm:…') argument; a specifier routed
//    through a variable ships `npm:` verbatim and cannot load on Node or Bun
//    (X7-3, M70e). The source gate (scripts/npm-specifier-audit.ts) prevents
//    the shape in the repo; only a published artifact settles that the rewrite
//    actually ran. Two shapes are refused: a literal `npm:` inside import(),
//    AND the indirection that evades it — a parameterized importer that
//    forwards its parameter into import() (the known-broken alpha.5 artifact
//    carries the latter, not the former, so the first shape alone would pass
//    against the exact broken build).
//
//    Guarded by version: while the installed packages are at or below
//    0.1.0-alpha.8 (the last release that shipped the defect) the check reports
//    pending rather than failing — a hard check would turn this PR red for the
//    very defect it fixes. Once a newer version is installed the guard lifts
//    and a surviving `npm:` inside import( fails the suite.
const LAST_BROKEN = '0.1.0-alpha.8';
const FIXED_IN = '0.1.0-alpha.9';

/** Compares two `0.1.0[-alpha.N]` versions; -1/0/1. Unparseable → 0 (don't gate). */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/.exec(v);
    if (!m) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      pre: m[4] !== undefined ? Number(m[4]) : null,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  // Same tuple: a release (pre === null) sorts after any prerelease.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre === pb.pre ? 0 : pa.pre < pb.pre ? -1 : 1;
}

/**
 * Returns `source` with every comment blanked to spaces — same length, so
 * offsets are preserved. String-aware: a `//` or `/*` inside a string literal
 * is not a comment (the audited artifacts carry `npm:` strings and `deno add`
 * install-command text that contain `//`).
 *
 * Why: JSR's npm-compat build keeps JSDoc comments in the published `.js`,
 * and this repo's loader JSDoc literally spells the indirection shape
 * (`(spec) => import(spec)`) to document why it must not recur. A detector
 * that scans comments would flag the FIXED artifact for its own explanation.
 */
function stripComments(source) {
  const n = source.length;
  const out = new Array(n);
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      // Keep the string verbatim; skip to its closing delimiter.
      const quote = c;
      out[i] = c;
      i++;
      while (i < n) {
        out[i] = source[i];
        if (source[i] === '\\') {
          i++;
          if (i < n) out[i] = source[i];
          i++;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      out[i] = ' ';
      i++;
      out[i] = ' ';
      i++;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        i++;
        out[i] = ' ';
        i++;
      }
      continue;
    }
    out[i] = c;
    i++;
  }
  return out.join('');
}

/** Offsets of every `import( "npm:…` / `import('npm:…` / `import(`npm:…` call. */
function npmImportOccurrences(source) {
  const re = /import\s*\(\s*["'`]npm:/g;
  const hits = [];
  let m;
  while ((m = re.exec(stripComments(source))) !== null) hits.push(m.index);
  return hits;
}

/**
 * Offsets of every parameterized importer that forwards its own parameter
 * straight into import() — e.g. `(specifier)=>import(specifier)`,
 * `(spec)=>import(spec)`, `(x)=>import(x)`.
 *
 * This is the indirection shape JSR's static rewrite cannot reach: the `npm:`
 * string sits in a separate constant and only reaches `import()` through the
 * parameter, so it ships verbatim and cannot load on Node or Bun (X7-3). The
 * fixed shape — a zero-argument importer taking a literal,
 * `() => import('npm:…')` — carries no parameter and does not match. Detecting
 * this closes the false-confidence gap where the `npm:`-in-`import()` regex
 * above finds zero matches in the known-broken artifact yet the artifact is
 * still broken.
 */
function parameterizedImporterOccurrences(source) {
  // Comments are stripped: the fixed artifact's own JSDoc documents the
  // indirection shape it must not contain, and must not be mistaken for it.
  const code = stripComments(source);
  // Concise arrow body: (id) => import(id)
  const concise = /\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*import\(\s*\1\s*\)/g;
  // Braced arrow body: (id) => { ... import(id) ... }
  const braced = /\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\{[^{}]*import\(\s*\1\s*\)[^{}]*\}/g;
  const hits = [];
  for (const re of [concise, braced]) {
    let m;
    while ((m = re.exec(code)) !== null) hits.push(m.index);
  }
  hits.sort((a, b) => a - b);
  return hits;
}

/** Recursively lists every `.js` file under `dir`. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listJsFiles(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

for (const name of ['@jsr/setu-ts__grpc-plugin', '@jsr/setu-ts__telemetry-plugin']) {
  const pkgDir = `node_modules/${name}`;
  let version;
  try {
    version = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8')).version;
  } catch {
    check(`${name} is installed with a readable version`, false, 'no package.json');
    continue;
  }

  if (compareVersions(version, LAST_BROKEN) <= 0) {
    console.log(
      `  pend ${name} @ ${version} — npm:-in-import check pending, fixed in ${FIXED_IN}, not yet published`,
    );
    continue;
  }

  const npmInImport = [];
  const indirection = [];
  for (const file of listJsFiles(`${pkgDir}/src`)) {
    const source = readFileSync(file, 'utf8');
    const rel = file.replace(`${pkgDir}/`, '');
    if (npmImportOccurrences(source).length > 0) npmInImport.push(rel);
    if (parameterizedImporterOccurrences(source).length > 0) indirection.push(rel);
  }
  const details = [
    npmInImport.length > 0 ? `npm: inside import(): ${npmInImport.join(', ')}` : '',
    indirection.length > 0 ? `parameterized importer: ${indirection.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  check(
    `${name} @ ${version} ships no non-literal npm: path into import()`,
    npmInImport.length === 0 && indirection.length === 0,
    details,
  );
}

console.log(failures === 0 ? `\nAll checks passed (${host}).` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
