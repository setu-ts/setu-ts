/**
 * Which requests the Workers adapter routes as an upgrade.
 *
 * Cloudflare's documented Worker-to-Worker socket sends `Upgrade: websocket`
 * without `Connection: Upgrade`. The adapter adds `Connection: Upgrade` to the
 * request the kernel routes on for such an internal subrequest (no `cf`) only;
 * a request from the edge, and any `Upgrade` other than `websocket`, is routed
 * as sent. The table drives each case through the adapter and reads what the
 * kernel's handler received.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type { IRequest, IResponse } from '@setu-ts/common';
import { isWebSocketUpgradeRequest } from '@setu-ts/common';
import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';

/** One request shape: its headers, whether it came from the edge, what the kernel sees. */
interface Row {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly edge: boolean;
  readonly upgrade: boolean;
  readonly connection: string | null;
}

const ROWS: readonly Row[] = [
  { name: 'an ordinary request', headers: {}, edge: false, upgrade: false, connection: null },
  {
    name: 'a full upgrade, routed as sent',
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
    edge: false,
    upgrade: true,
    connection: 'Upgrade',
  },
  {
    name: 'an internal Upgrade-only call',
    headers: { upgrade: 'websocket' },
    edge: false,
    upgrade: true,
    connection: 'Upgrade',
  },
  {
    name: 'an internal call whose Connection names another token',
    headers: { upgrade: 'websocket', connection: 'keep-alive' },
    edge: false,
    upgrade: true,
    connection: 'keep-alive, Upgrade',
  },
  {
    name: 'an Upgrade-only request from the edge',
    headers: { upgrade: 'websocket' },
    edge: true,
    upgrade: false,
    connection: null,
  },
  {
    name: 'an internal call asking for another protocol',
    headers: { upgrade: 'h2c' },
    edge: false,
    upgrade: false,
    connection: null,
  },
];

/** A response for the handler, which only records what it was given. */
const ok = {
  status: 200,
  headers: new Headers(),
  body: null,
  snapshot: () => ({ status: 200, headers: new Headers(), body: null, streaming: false }),
} as unknown as IResponse;

describe('the Workers adapter routes a Worker-to-Worker Upgrade-only call as an upgrade', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      let seen: IRequest | undefined;
      const adapter = new CloudflareWorkersHttpAdapter();
      adapter.setHandler((request: IRequest): IResponse => {
        seen = request;
        return ok;
      });
      const request = new Request('http://worker/ws', { headers: row.headers });
      if (row.edge) Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });

      await adapter.fetch(request);

      expect(isWebSocketUpgradeRequest(seen!.headers)).toBe(row.upgrade);
      expect(seen!.headers.get('connection')).toBe(row.connection);
    });
  }
});
