/**
 * Registers {@link ./node-source-hooks.ts} in a test subprocess (`node --import`).
 *
 * @module
 */
import { registerHooks } from 'node:module';
import { resolve } from './node-source-hooks.ts';

// Synchronous hooks preserve the source redirect without creating a loader
// worker, which the documentation probe's permission model deliberately denies.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return resolve(
      specifier,
      context.parentURL === undefined ? {} : { parentURL: context.parentURL },
      (nextSpecifier) => nextResolve(nextSpecifier, context),
    );
  },
});
