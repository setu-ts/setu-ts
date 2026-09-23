/**
 * The GCP `endpoint` option against the REAL `@google-cloud/secret-manager`
 * client (M99d review fix).
 *
 * The unit tests assert what the adapter hands a fake constructor. This suite
 * asserts what the real client RESOLVES from it, because the SDK is where the
 * original defect lived: google-gax builds its address as
 * `servicePath + ':' + port` (default 443), so a `host:port` endpoint forwarded
 * whole as `apiEndpoint` resolved to `host:port:443` — unreachable, with no
 * diagnostic until the first call. The client's `apiEndpoint` getter returns
 * the DEFAULT service path, not the configured one, so the resolved address is
 * read from the options gax builds its stub from (`_opts.servicePath` and
 * `_opts.port`) — the pair `createStub` concatenates.
 *
 * No request is sent: constructing the client resolves the address and needs
 * no credentials. Guarded on the SDK loading, so a machine without the npm
 * package reports the case ignored rather than passing vacuously.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  adaptGcpModule,
  type GcpSdkModule,
  loadGcpModule,
} from '../../src/providers/gcp-secret-manager.ts';

let sdk: GcpSdkModule | undefined;
try {
  sdk = await loadGcpModule();
} catch {
  // npm:@google-cloud/secret-manager not available
}

/** Builds a client through the adapter and returns the address gax resolved. */
function resolvedAddress(mod: GcpSdkModule, endpoint?: string): string {
  let captured: { _opts: { servicePath: string; port: number } } | undefined;
  const Real = mod.SecretManagerServiceClient;
  class Recording extends Real {
    constructor(options?: Record<string, unknown>) {
      super(options);
      captured = this as unknown as { _opts: { servicePath: string; port: number } };
    }
  }
  adaptGcpModule(
    { SecretManagerServiceClient: Recording },
    endpoint === undefined ? { projectId: 'p' } : { projectId: 'p', endpoint },
  );
  if (captured === undefined) {
    throw new Error('the adapter constructed no client');
  }
  return `${captured._opts.servicePath}:${captured._opts.port}`;
}

describe('GcpSecretManagerProvider endpoint against the real SDK (M99d)', () => {
  it('defaults to the production service on 443', { ignore: sdk === undefined }, () => {
    expect(resolvedAddress(sdk!)).toBe('secretmanager.googleapis.com:443');
  });

  it('addresses a bare host on 443', { ignore: sdk === undefined }, () => {
    expect(resolvedAddress(sdk!, 'secretmanager.private.example')).toBe(
      'secretmanager.private.example:443',
    );
  });

  it('addresses `host:port` at that port, not `host:port:443`', {
    ignore: sdk === undefined,
  }, () => {
    expect(resolvedAddress(sdk!, 'localhost:8085')).toBe('localhost:8085');
  });
});
