/**
 * The handshake header rules the Deno and Workers adapters apply, as Node's
 * `ws` 8.23.0 does (V13-276, V13-278): a 16-byte base64 key, and a version the
 * platform speaks — `ws`'s numeric 13 or 8 on Deno, workerd's exact `13` on
 * Workers.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import {
  refuseHandshakeHeaders,
  WORKERD_VERSION_RULE,
  WS_VERSION_RULE,
} from '../../src/adapters/shared/handshake-headers.ts';

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const BAD_KEY = { header: 'key', reason: 'Missing or invalid Sec-WebSocket-Key header' };
const BAD_VERSION = {
  header: 'version',
  reason: 'Missing or invalid Sec-WebSocket-Version header',
};

/** Each row: the two headers, then the refusal under `ws`'s rule and under workerd's. */
const ROWS: readonly [string, string | undefined, string | undefined, unknown, unknown][] = [
  ['a valid handshake', KEY, '13', undefined, undefined],
  ['version 8', KEY, '8', undefined, BAD_VERSION],
  ['a version with surrounding whitespace, as ws reads it', KEY, ' 13 ', undefined, undefined],
  ['no key', undefined, '13', BAD_KEY, BAD_KEY],
  ['a short key', 'short', '13', BAD_KEY, BAD_KEY],
  ['a key without its padding', 'dGhlIHNhbXBsZSBub25jZQ', '13', BAD_KEY, BAD_KEY],
  ['a 24-character key that is not base64', 'dGhlIHNhbXBsZSBub25jZ!==', '13', BAD_KEY, BAD_KEY],
  ['a key and no version', KEY, undefined, BAD_VERSION, BAD_VERSION],
  ['an empty version', KEY, '', BAD_VERSION, BAD_VERSION],
  ['version 7', KEY, '7', BAD_VERSION, BAD_VERSION],
  ['a version that is not a number', KEY, 'thirteen', BAD_VERSION, BAD_VERSION],
  // Numeric spellings of 13: `ws` reads them as 13, workerd refuses them.
  ['version 0x0d', KEY, '0x0d', undefined, BAD_VERSION],
  ['version +13', KEY, '+13', undefined, BAD_VERSION],
  ['version 1.3e1', KEY, '1.3e1', undefined, BAD_VERSION],
  ['version 13.0', KEY, '13.0', undefined, BAD_VERSION],
  ['version 013', KEY, '013', undefined, BAD_VERSION],
];

describe('refuseHandshakeHeaders', () => {
  for (const [name, key, version, deno, workers] of ROWS) {
    it(name, () => {
      const headers = new Headers();
      if (key !== undefined) headers.set('sec-websocket-key', key);
      if (version !== undefined) headers.set('sec-websocket-version', version);

      expect(refuseHandshakeHeaders(headers, WS_VERSION_RULE)).toEqual(deno);
      expect(refuseHandshakeHeaders(headers, WORKERD_VERSION_RULE)).toEqual(workers);
    });
  }

  it('checks the key before the version, as ws does', () => {
    expect(refuseHandshakeHeaders(new Headers(), WORKERD_VERSION_RULE)).toEqual(BAD_KEY);
  });
});
