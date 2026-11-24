/**
 * The handshake header rules the Deno and Workers adapters apply, as Node's
 * `ws` 8.23.0 does (V13-276, V13-278): a 16-byte base64 key, and a version the
 * platform speaks — 13 or 8 on Deno (`ws`'s set), 13 on Workers.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { refuseHandshakeHeaders } from '../../src/adapters/shared/handshake-headers.ts';

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const BAD_KEY = { header: 'key', reason: 'Missing or invalid Sec-WebSocket-Key header' };
const BAD_VERSION = {
  header: 'version',
  reason: 'Missing or invalid Sec-WebSocket-Version header',
};

/** Each row: the two headers, then the refusal for Deno's [13, 8] and Workers' [13]. */
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
];

describe('refuseHandshakeHeaders', () => {
  for (const [name, key, version, deno, workers] of ROWS) {
    it(name, () => {
      const headers = new Headers();
      if (key !== undefined) headers.set('sec-websocket-key', key);
      if (version !== undefined) headers.set('sec-websocket-version', version);

      expect(refuseHandshakeHeaders(headers, [13, 8])).toEqual(deno);
      expect(refuseHandshakeHeaders(headers, [13])).toEqual(workers);
    });
  }

  it('checks the key before the version, as ws does', () => {
    expect(refuseHandshakeHeaders(new Headers(), [13])).toEqual(BAD_KEY);
  });
});
