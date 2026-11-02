/**
 * `maskUrlUserinfo` and the default redaction policy's value-based URL rule
 * (M131a X88-8).
 *
 * A malformed `REDIS_URL` often holds a password; it must never be echoed into
 * a log, trace or audit record. The rule is one linear pattern with no
 * backtracking, applied to every string value whatever its length.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createRedactionService, maskUrlUserinfo } from '../../src/index.ts';

/** The classification table: input → expected masked output. */
const MASK_TABLE: ReadonlyArray<readonly [input: string, expected: string]> = [
  // Credentials are masked, scheme and host preserved.
  ['redis://user:password@host:6379', 'redis://***@host:6379'],
  ['redis://:password@host', 'redis://***@host'],
  ['redis://user@host', 'redis://***@host'],
  ['https://admin:hunter2@internal.corp/api', 'https://***@internal.corp/api'],
  ['amqp://guest:guest@localhost:5672/%2F', 'amqp://***@localhost:5672/%2F'],
  // Multiple URLs in one string are each masked.
  ['redis://a:b@h1 and redis://c:d@h2', 'redis://***@h1 and redis://***@h2'],
  // No userinfo → untouched.
  ['redis://host:6379', 'redis://host:6379'],
  ['https://example.com/path', 'https://example.com/path'],
  // An email (no `://`) is untouched.
  ['user@example.com', 'user@example.com'],
  // An `@` inside a path is untouched.
  ['https://example.com/@handle', 'https://example.com/@handle'],
  // A bare `@` with no scheme is untouched.
  ['not a url @ all', 'not a url @ all'],
  // A `://` with no scheme before it, or an empty userinfo, is untouched.
  ['://user:pw@host', '://user:pw@host'],
  ['1+.://user:pw@host', '1+.://user:pw@host'],
  ['redis://@host', 'redis://@host'],
  // A leading non-letter is not part of the scheme.
  ['9redis://u:p@host', '9redis://***@host'],
  // Back-to-back separators: the userinfo stops at the next `/`.
  ['a://b://u:p@h', 'a://b://***@h'],
  // A space ends the URL.
  ['redis://user pw@host', 'redis://user pw@host'],
  // Malformed URLs: an unencoded `@`, `/`, `#` or `?` in the password is masked
  // through the LAST `@` (the X88-8 case: a malformed REDIS_URL).
  ['redis://:p@ss@host:6379', 'redis://***@host:6379'],
  ['redis://:p@ss/word@host', 'redis://***@host'],
  ['redis://user:p/ss@host', 'redis://***@host'],
  ['redis://user:p#ss@host', 'redis://***@host'],
  ['redis://user:p?ss@host', 'redis://***@host'],
  // A path `@` with no `:` before it is untouched; after a port it is
  // over-masked, erring toward hiding.
  ['https://host/a@b', 'https://host/a@b'],
  ['https://host:8080/@handle', 'https://***@handle'],
  // A query `@` with no colon is untouched.
  ['https://host/?to=a@b', 'https://host/?to=a@b'],
];

describe('maskUrlUserinfo (M131a X88-8)', () => {
  it('masks URL userinfo and leaves non-credential strings untouched', () => {
    for (const [input, expected] of MASK_TABLE) {
      expect(maskUrlUserinfo(input), `mask ${input}`).toBe(expected);
    }
  });

  it('masks a credentialed URL inside a string of any length', () => {
    const long = `${'x'.repeat(200_000)} redis://user:secret@host ${'y'.repeat(200_000)}`;
    const masked = maskUrlUserinfo(long);
    expect(masked).not.toContain('secret');
    expect(masked).toContain('redis://***@host');
    expect(masked.length).toBe(long.length - 'user:secret'.length + 3);
  });

  it('scans a pathological string in linear time', () => {
    const hostile = 'a'.repeat(500_000) + '://'.repeat(100_000) + 'a'.repeat(500_000);
    const started = performance.now();
    expect(maskUrlUserinfo(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('is idempotent (a second pass changes nothing)', () => {
    const once = maskUrlUserinfo('redis://user:password@host');
    expect(maskUrlUserinfo(once)).toBe(once);
  });

  it('masks a credentialed URL in a nested record value', () => {
    const service = createRedactionService({ fields: {} });
    const record = service.redactRecord({
      message: 'connecting',
      config: { url: 'redis://user:password@host:6379' },
    });
    expect((record.config as { url: string }).url).toBe('redis://***@host:6379');
  });

  it('masks a credentialed URL on a non-classified top-level value', () => {
    const service = createRedactionService({ fields: {} });
    const record = service.redactRecord({ url: 'redis://user:password@host' });
    expect(record.url).toBe('redis://***@host');
  });
});
