import { describe, expect, it } from 'vitest';
import {
  isLoopbackAddress,
  isLoopbackName,
  isPasskeyLoopbackName,
} from '../../src/utils/loopback.ts';
import { isAcceptableFetchUrl, isAcceptableUrl } from '../../src/issuers/trusted-issuer.ts';

describe('M139a loopback rules', () => {
  it.each([
    ['acme.localhost', true, false, true],
    ['a.b.localhost', true, false, true],
    ['localhost', true, true, true],
    ['127.0.0.1', true, true, true],
    ['[::1]', true, true, false],
    ['notlocalhost', false, false, false],
    ['localhost.evil.test', false, false, false],
    ['evil-localhost', false, false, false],
    ['127.0.0.2', false, false, false],
  ] as const)('%s: name %j, fetch %j, passkey %j', (host, name, address, passkey) => {
    expect(isLoopbackName(host)).toBe(name);
    expect(isLoopbackAddress(host)).toBe(address);
    expect(isPasskeyLoopbackName(host)).toBe(passkey);
    expect(isAcceptableUrl(`http://${host}:3000`)).toBe(name);
    expect(isAcceptableFetchUrl(`http://${host}:3000`)).toBe(address);
  });
  it.each(['https://example.test', 'http://localhost', 'http://127.0.0.1', 'http://[::1]'])(
    'retains fetch acceptance for %s',
    (url) => {
      expect(isAcceptableFetchUrl(url)).toBe(true);
    },
  );
  it.each(['not a url', 'https://example.test/é', 'https://example.test/\n', 'ftp://localhost'])(
    'retains fetch refusal for %s',
    (url) => {
      expect(isAcceptableFetchUrl(url)).toBe(false);
    },
  );
});
