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
 * the storage real-emulator suites use for `S3_ENDPOINT_URL`).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { AwsKmsProvider } from '../../src/providers/aws-kms.ts';

const endpoint = Deno.env.get('AWS_ENDPOINT_URL');
let sdkPresent = false;
if (endpoint !== undefined) {
  try {
    await import('npm:@aws-sdk/client-secrets-manager@^3');
    sdkPresent = true;
  } catch {
    // npm:@aws-sdk/client-secrets-manager not available
  }
}
const skip = endpoint === undefined || !sdkPresent;

describe('AwsKmsProvider against a real LocalStack (X28-1)', () => {
  it('returns null for an absent secret rather than throwing', { ignore: skip }, async () => {
    const provider = new AwsKmsProvider({
      endpoint,
      region: Deno.env.get('AWS_REGION') ?? 'us-east-1',
      accessKeyId: Deno.env.get('AWS_ACCESS_KEY_ID') ?? 'test',
      secretAccessKey: Deno.env.get('AWS_SECRET_ACCESS_KEY') ?? 'test',
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
