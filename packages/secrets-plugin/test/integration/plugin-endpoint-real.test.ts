/**
 * The `endpoint` option through the PLUGIN path (M99d review fix).
 *
 * The unit tests drive `new AwsKmsProvider({ endpoint })` directly; this suite
 * drives the documented surface — `SecretsPlugin({ provider: 'aws-kms',
 * options: { endpoint } })` — through the real kernel app, the real
 * `createProvider` seam, and the real `npm:@aws-sdk/client-secrets-manager`
 * import, against a local stub Secrets Manager. If `createProvider` drops the
 * field, the client targets the real cloud and every assertion below fails on
 * credentials or network — the silent-decline defect class this milestone
 * exists to fix.
 *
 * The stub speaks the JSON 1.1 protocol the real SDK client uses
 * (`x-amz-target: secretsmanager.GetSecretValue`, a JSON body): it answers with
 * the `GetSecretValue` JSON the SDK parses, and a `ResourceNotFoundException`
 * error for an absent secret — the error name the provider maps to `null`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { ISecretManager } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { SecretsPlugin } from '../../src/index.ts';

const SECRETS = new Map<string, string>([['plugin/secret', 'plugin-value']]);

/** The minimal JSON 1.1 stub the real SDK client talks to. */
function startStub(): { url: string; close: () => Promise<void> } {
  let port = 0;
  // Loopback only: the package's test `net` grant is scoped to `127.0.0.1`
  // (any port, since this stub's is ephemeral), so no test can reach a real
  // cloud endpoint by accident.
  const server = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    onListen: (l) => {
      port = l.port;
    },
  }, async (req) => {
    const target = req.headers.get('x-amz-target') ?? '';
    if (target === 'secretsmanager.GetSecretValue') {
      const { SecretId } = JSON.parse(await req.text()) as { SecretId: string };
      const value = SECRETS.get(SecretId);
      if (value === undefined) {
        return Response.json(
          {
            __type: 'ResourceNotFoundException',
            Message: "Secrets Manager can't find the specified secret.",
          },
          { status: 400 },
        );
      }
      return Response.json({
        ARN: `arn:aws:secretsmanager:local:1:secret:${value}`,
        Name: value,
        SecretString: value,
        VersionId: 'v1',
      });
    }
    return Response.json(
      {
        __type: 'UnknownOperation',
        Message: `stub saw an operation it does not answer: ${target}`,
      },
      { status: 400 },
    );
  });
  return {
    url: `http://127.0.0.1:${port}`,
    // shutdown() closes the SDK's idle keep-alive connections; awaiting
    // finished() FIRST would hang on them.
    close: () => server.shutdown(),
  };
}

describe('SecretsPlugin endpoint option (M99d review fix)', () => {
  it('threads options.endpoint to the real SDK client through createProvider', async () => {
    const stub = startStub();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SecretsPlugin({
          provider: 'aws-kms',
          options: {
            endpoint: stub.url,
            region: 'us-east-1',
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
        }),
      ],
    });
    try {
      await app.start();
      const secrets = app.services.get<ISecretManager>(CAPABILITIES.SECRETS);

      // The value can only come from the stub: if `endpoint` were dropped by
      // createProvider the client would target the real cloud and reject.
      expect(await secrets.get('plugin/secret')).toBe('plugin-value');
      expect(await secrets.has('plugin/secret')).toBe(true);

      // X28-1 through the plugin path: an absent secret is a clean throw from
      // the service (provider `null`), not a credentials failure.
      // The exact message: a bare `toThrow()` would also pass on the credentials
      // or network failure this assertion exists to rule out.
      await expect(secrets.get('absent/secret')).rejects.toThrow(
        'Secret not found: absent/secret',
      );
      expect(await secrets.has('absent/secret')).toBe(false);
    } finally {
      await app.stop();
      await stub.close();
    }
  });
});
