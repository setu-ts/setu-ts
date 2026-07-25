/**
 * Guarded REAL-import test for `ws`.
 *
 * Every other Node-upgrade test drives an injected fake module, so this is the
 * one place the actual `import('npm:ws@^8.18.0')` inside `loadWsModule` runs.
 * Without it, a fake that agreed with our assumptions but not with the real
 * package would go unnoticed (CLAUDE.md: at least one test must exercise the
 * REAL load path).
 *
 * Skipped when `ws` cannot be resolved, so the suite stays green in an
 * environment without the optional dependency installed.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadWsModule } from '../../src/adapters/node/node-ws-upgrader.ts';

/** Probes once whether the optional dependency is resolvable. */
const wsAvailable = await (async (): Promise<boolean> => {
  try {
    await loadWsModule();
    return true;
  } catch {
    return false;
  }
})();

describe('loadWsModule (real npm:ws)', () => {
  it({
    name: 'resolves the real ws module and satisfies WsModuleLike',
    ignore: !wsAvailable,
    fn: async () => {
      const module = await loadWsModule();

      expect(typeof module.WebSocketServer).toBe('function');
    },
  });

  it({
    name: 'constructs a real noServer WebSocketServer with a protocol selector',
    ignore: !wsAvailable,
    fn: async () => {
      const { WebSocketServer } = await loadWsModule();

      // The exact shape the Node adapter builds — proving the real constructor
      // accepts it, not just that our fake does.
      const server = new WebSocketServer({
        noServer: true,
        handleProtocols: () => 'chat',
      });
      try {
        expect(typeof server.handleUpgrade).toBe('function');
        expect(typeof server.close).toBe('function');
      } finally {
        server.close();
      }
    },
  });
});
