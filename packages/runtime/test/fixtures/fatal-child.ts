/**
 * Child process for the fatal-error proof: subscribes the runtime's own
 * observer, writes one JSON line per report to stdout, then dies the way the
 * first argument says. Imports only the observer module, which needs nothing
 * at run time, so Node (type stripping), Bun and Deno all run it from source.
 *
 * Arguments: `throw` | `reject`, and optionally `own-listener` to give the
 * application its own `unhandledRejection` listener first.
 *
 * @module
 */
import process from 'node:process';

import {
  createBunFatalErrorObserver,
  createDenoFatalErrorObserver,
  createNodeFatalErrorObserver,
} from '../../src/adapters/shared/fatal-error-observer.ts';
import type {
  GlobalEventHost,
  ProcessEventHost,
} from '../../src/adapters/shared/fatal-error-observer.ts';

const [mode, extra] = process.argv.slice(2);
const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

if (extra === 'own-listener') {
  process.on('unhandledRejection', () => {
    process.stdout.write('{"own":true}\n');
  });
}

const subscribe = isDeno
  ? createDenoFatalErrorObserver(globalThis as unknown as GlobalEventHost)
  : isBun
    ? createBunFatalErrorObserver(process as unknown as ProcessEventHost)
    : createNodeFatalErrorObserver(process as unknown as ProcessEventHost);

subscribe((error, origin) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ origin, message })}\n`);
});

setTimeout(() => {
  if (mode === 'throw') throw new Error('fatal-throw');
  void Promise.reject(new Error('fatal-reject'));
}, 10);
// Proves a process that should have survived did: printed only if still alive.
setTimeout(() => process.stdout.write('{"alive":true}\n'), 300);
