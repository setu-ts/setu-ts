/**
 * The handshake header rules Deno's adapter applies, as Node's `ws` 8.23.0
 * does (V13-276): a 16-byte base64 key, version 13 or 8.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { refuseHandshakeHeaders } from '../../src/adapters/shared/handshake-headers.ts';

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const BAD_KEY = { reason: 'Missing or invalid Sec-WebSocket-Key header', headers: {} };
const BAD_VERSION = {
  reason: 'Missing or invalid Sec-WebSocket-Version header',
  headers: { 'sec-websocket-version': '13, 8' },
};

/** Each row: the two headers, and the refusal (or none). */
const ROWS: readonly [string, string | undefined, string | undefined, unknown][] = [
  ['a valid handshake', KEY, '13', undefined],
  ['version 8', KEY, '8', undefined],
  ['a version with surrounding whitespace, as ws reads it', KEY, ' 13 ', undefined],
  ['no key', undefined, '13', BAD_KEY],
  ['a short key', 'short', '13', BAD_KEY],
  ['a key without its padding', 'dGhlIHNhbXBsZSBub25jZQ', '13', BAD_KEY],
  ['a 24-character key that is not base64', 'dGhlIHNhbXBsZSBub25jZ!==', '13', BAD_KEY],
  ['a key and no version', KEY, undefined, BAD_VERSION],
  ['an empty version', KEY, '', BAD_VERSION],
  ['version 7', KEY, '7', BAD_VERSION],
  ['a version that is not a number', KEY, 'thirteen', BAD_VERSION],
];

describe('refuseHandshakeHeaders', () => {
  for (const [name, key, version, refusal] of ROWS) {
    it(name, () => {
      const headers = new Headers();
      if (key !== undefined) headers.set('sec-websocket-key', key);
      if (version !== undefined) headers.set('sec-websocket-version', version);

      expect(refuseHandshakeHeaders(headers)).toEqual(refusal);
    });
  }

  it('checks the key before the version, as ws does', () => {
    expect(refuseHandshakeHeaders(new Headers())).toEqual(BAD_KEY);
  });
});
