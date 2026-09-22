import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { adaptAwsModule, AwsKmsProvider, type AwsSdkModule } from '../../src/providers/aws-kms.ts';
import {
  adaptGcpModule,
  type GcpSdkModule,
  GcpSecretManagerProvider,
} from '../../src/providers/gcp-secret-manager.ts';
import type { IAwsSecretsClient, IGcpSecretsClient } from '../../src/interfaces/index.ts';

/**
 * The `endpoint` option, per provider (M99d §3.4/§3.4a).
 *
 * The load-bearing assertion is the KEY each SDK is actually handed, because
 * the two SDKs do not agree on it: AWS's config object takes `endpoint`, while
 * google-gax's `ClientOptions` declares `apiEndpoint` and has NO `endpoint`
 * member. Worse, gax's `ClientStubOptions` carries an index signature, so a
 * verbatim `endpoint` would type-check, construct, and be ignored at runtime —
 * the client would talk to the production endpoint with no diagnostic. Each
 * provider therefore asserts its own key is present with the unmodified value
 * AND the other key is ABSENT, so forwarding the wrong member fails here rather
 * than being silently dropped.
 */

/** A fake AWS SDK module that records the constructor config it is handed. */
function recordingAwsModule(store: Map<string, string>): {
  configs: Record<string, unknown>[];
  mod: AwsSdkModule;
} {
  const configs: Record<string, unknown>[] = [];
  class GetCmd {
    readonly type = 'get';
    constructor(readonly input: { SecretId: string }) {}
  }
  class PutCmd {
    readonly type = 'put';
    constructor(readonly input: { SecretId: string; SecretString: string }) {}
  }
  class Client {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
    send(cmd: unknown): Promise<{ SecretString?: string | undefined }> {
      const c = cmd as GetCmd | PutCmd;
      if (c.type === 'get') {
        return Promise.resolve({ SecretString: store.get(c.input.SecretId) });
      }
      store.set(c.input.SecretId, (c as PutCmd).input.SecretString);
      return Promise.resolve({});
    }
  }
  return {
    configs,
    mod: {
      SecretsManagerClient: Client,
      GetSecretValueCommand: GetCmd,
      PutSecretValueCommand: PutCmd,
    } as unknown as AwsSdkModule,
  };
}

/** A fake GCP SDK module that records the constructor argument it is handed. */
function recordingGcpModule(store: Map<string, string>): {
  configs: (Record<string, unknown> | undefined)[];
  mod: GcpSdkModule;
} {
  const configs: (Record<string, unknown> | undefined)[] = [];
  class Client {
    constructor(options?: Record<string, unknown>) {
      configs.push(options);
    }
    accessSecretVersion(
      request: { name: string },
    ): Promise<[{ payload?: { data?: string | Uint8Array | null } }]> {
      const short = request.name.split('/secrets/')[1].split('/versions/')[0];
      const value = store.get(short);
      if (value === undefined) {
        return Promise.resolve([{ payload: { data: null } }]);
      }
      return Promise.resolve([{ payload: { data: new TextEncoder().encode(value) } }]);
    }
    addSecretVersion(
      request: { parent: string; payload: { data: Uint8Array } },
    ): Promise<unknown> {
      const short = request.parent.split('/secrets/')[1];
      store.set(short, new TextDecoder().decode(request.payload.data));
      return Promise.resolve({});
    }
  }
  return { configs, mod: { SecretManagerServiceClient: Client } as unknown as GcpSdkModule };
}

describe('AwsKmsProvider endpoint (M99d)', () => {
  it('passes no endpoint key when the option is absent', () => {
    const { configs, mod } = recordingAwsModule(new Map([['k', 'v']]));
    adaptAwsModule(mod, { region: 'us-east-1' });
    expect(configs).toHaveLength(1);
    expect(configs[0].endpoint).toBeUndefined();
    // The GCP SDK's key must not leak into the AWS config under either spelling.
    expect(configs[0].apiEndpoint).toBeUndefined();
  });

  it('passes the endpoint VALUE unmodified under the AWS `endpoint` key', () => {
    const { configs, mod } = recordingAwsModule(new Map());
    adaptAwsModule(mod, { endpoint: 'http://localhost:4566' });
    expect(configs).toHaveLength(1);
    expect(configs[0].endpoint).toBe('http://localhost:4566');
    expect(configs[0].apiEndpoint).toBeUndefined();
  });

  it('ignores the endpoint when a client is injected', async () => {
    const client: IAwsSecretsClient = {
      getSecretValue: () => Promise.resolve('injected'),
      putSecretValue: () => Promise.resolve(),
    };
    const provider = new AwsKmsProvider({ client, endpoint: 'http://localhost:4566' });
    await provider.connect();
    // The injected facade is used, not the lazy module — the endpoint never
    // reaches a constructed client.
    expect(await provider.get('any')).toBe('injected');
    await provider.disconnect();
  });
});

describe('GcpSecretManagerProvider endpoint (M99d)', () => {
  it('passes no constructor argument when the option is absent', () => {
    const { configs, mod } = recordingGcpModule(new Map([['k', 'v']]));
    adaptGcpModule(mod, { projectId: 'p' });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toBeUndefined();
  });

  it('translates the endpoint to the SDK `apiEndpoint` key, not `endpoint`', () => {
    const { configs, mod } = recordingGcpModule(new Map());
    adaptGcpModule(mod, { projectId: 'p', endpoint: 'http://localhost:4443' });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toEqual({ apiEndpoint: 'http://localhost:4443' });
    // The wrong key would type-check against gax's index signature and be
    // ignored at runtime; asserting its absence is what catches that.
    expect(configs[0]?.endpoint).toBeUndefined();
  });

  it('ignores the endpoint when a client is injected', async () => {
    const client: IGcpSecretsClient = {
      accessSecretVersion: () => Promise.resolve('injected'),
      addSecretVersion: () => Promise.resolve(),
    };
    const provider = new GcpSecretManagerProvider({
      projectId: 'p',
      client,
      endpoint: 'http://localhost:4443',
    });
    await provider.connect();
    // The injected facade is used, not the lazy module — the endpoint never
    // reaches a constructed client.
    expect(await provider.get('any')).toBe('injected');
    await provider.disconnect();
  });
});
