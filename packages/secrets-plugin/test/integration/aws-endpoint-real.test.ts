/**
 * X28-1, made answerable (M99d §6): against a real LocalStack, does `get` on an
 * ABSENT secret return `null` rather than throwing?
 *
 * Before the `endpoint` option existed this was unanswerable outside the real
 * cloud: the lazy `@aws-sdk/client-secrets-manager` client had no channel to a
 * non-production endpoint, so the only way to point it at LocalStack was to
 * reach AWS and fail on credentials. Now `endpoint` threads LocalStack's
 * address to the SDK, and this suite drives the real lazy path against it.
 *
 * Guarded on `AWS_ENDPOINT_URL`: absent it, the suite is IGNORED rather than a
 * pass that asserted nothing. It does not manage the container — `AWS_ENDPOINT_URL`
 * is expected to point at an already-running `localstack:3` (the same arrangement
 * the storage real-emulator suites use for `S3_ENDPOINT_URL`). The package's
 * test `net` grant covers `127.0.0.1` (any port) and `localhost:4566`, so point
 * it at one of those — e.g. `AWS_ENDPOINT_URL=http://127.0.0.1:4566`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { AwsKmsProvider } from '../../src/providers/aws-kms.ts';

const endpoint = process.env['AWS_ENDPOINT_URL'];
let sdkPresent = false;
if (endpoint !== undefined) {
  try {
    await import('@aws-sdk/client-secrets-manager');
    sdkPresent = true;
  } catch {
    // npm:@aws-sdk/client-secrets-manager not available
  }
}
const skip = endpoint === undefined || !sdkPresent;

describe('AwsKmsProvider against a real LocalStack (X28-1)', () => {
  it('returns null for an absent secret rather than throwing', { skip: skip }, async () => {
    const provider = new AwsKmsProvider({
      endpoint,
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
    });
    try {
      await provider.connect();
      expect(provider.isReady()).toBe(true);
      // The actual question: an absent secret is a clean `null`, not a throw.
      // If `endpoint` were not threaded, this would reach AWS and reject on
      // credentials — the condition that made X20b's part (b) vacuous.
      expect(await provider.get('m99d-absent-secret')).toBeNull();
    } finally {
      await provider.disconnect();
    }
  });
});
