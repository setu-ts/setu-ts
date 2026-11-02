/**
 * `maskUrlUserinfo` and the default redaction policy's value-based URL rule
 * (M131a X88-8).
 *
 * A malformed `REDIS_URL` often holds a password; it must never be echoed into
 * a log, trace or audit record. The rule is one linear pattern with no
 * backtracking, applied to string values only and within the redaction seam's
 * size bounds.
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
];

describe('maskUrlUserinfo (M131a X88-8)', () => {
  it('masks URL userinfo and leaves non-credential strings untouched', () => {
    for (const [input, expected] of MASK_TABLE) {
      expect(maskUrlUserinfo(input), `mask ${input}`).toBe(expected);
    }
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
