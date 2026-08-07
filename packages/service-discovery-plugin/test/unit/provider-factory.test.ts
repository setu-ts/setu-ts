/**
 * Unit tests for the provider factory.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createProvider } from '../../src/providers/provider-factory.ts';
import { resolveOptions } from '../../src/options.ts';
import { StaticProvider } from '../../src/providers/static-provider.ts';
import { ConsulProvider } from '../../src/providers/consul-provider.ts';
import { KubernetesProvider } from '../../src/providers/kubernetes-provider.ts';
import { DnsProvider } from '../../src/providers/dns-provider.ts';
import { DiscoveryUnavailableError } from '../../src/errors.ts';
import type { DiscoveryProvider } from '../../src/interfaces/index.ts';
import type { IFileSystem } from '@setu-ts/common';
import { createFakeDns, createFakeHttp, createFakeRuntime } from '../fixtures/fakes.ts';

const noopFs = {
  readFile: () => Promise.resolve(new Uint8Array()),
  writeFile: () => Promise.resolve(),
  stat: () => Promise.reject(new Error('unused')),
  readdir: () => Promise.resolve([] as readonly string[]),
  mkdir: () => Promise.resolve(),
  rm: () => Promise.resolve(),
} as IFileSystem;

describe('createProvider — arms', () => {
  it('builds a StaticProvider for the static arm', () => {
    const options = { provider: 'static', services: {} } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());
    expect(provider).toBeInstanceOf(StaticProvider);
  });

  it('builds a ConsulProvider for the consul arm', () => {
    const options = { provider: 'consul', address: 'http://consul:8500' } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());
    expect(provider).toBeInstanceOf(ConsulProvider);
  });

  it('builds a KubernetesProvider for the kubernetes arm', () => {
    const options = {
      provider: 'kubernetes',
      namespace: 'default',
      apiServer: 'https://api',
      token: 't',
    } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());
    expect(provider).toBeInstanceOf(KubernetesProvider);
  });

  it('builds a DnsProvider for the dns arm', () => {
    const options = { provider: 'dns', mode: 'srv' } as const;
    const runtime = createFakeRuntime({ dns: createFakeDns({}) });
    const provider = createProvider(options, resolveOptions(options), runtime);
    expect(provider).toBeInstanceOf(DnsProvider);
  });

  it("returns the custom arm's provider identically", () => {
    const own: DiscoveryProvider = {
      kind: 'own',
      resolve: () => Promise.resolve([]),
      watch: () => Promise.resolve(() => {}),
    };
    const options = { provider: 'custom', discovery: own } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());
    expect(provider).toBe(own);
  });
});

describe('createProvider — the http seam', () => {
  it('the http option overrides the default seam for consul', async () => {
    const http = createFakeHttp([{ text: '[]' }]);
    const options = { provider: 'consul', address: 'http://consul:8500', http } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());

    await provider.resolve('billing');
    expect(http.calls).toHaveLength(1);
  });

  it('the http option overrides the default seam for kubernetes', async () => {
    const http = createFakeHttp([{ text: '{"items":[]}' }]);
    const options = {
      provider: 'kubernetes',
      namespace: 'default',
      apiServer: 'https://api',
      token: 't',
      http,
    } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());

    await provider.resolve('billing');
    expect(http.calls).toHaveLength(1);
  });
});

describe('createProvider — kubernetes API server resolution', () => {
  it('derives the in-cluster API server from the environment', async () => {
    const http = createFakeHttp([{ text: '{"items":[]}' }]);
    const runtime = createFakeRuntime({
      env: { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' },
    });
    const options = { provider: 'kubernetes', namespace: 'default', token: 't', http } as const;
    const provider = createProvider(options, resolveOptions(options), runtime);

    await provider.resolve('billing');
    expect(http.calls[0].url).toContain('https://10.96.0.1:443/apis/discovery.k8s.io/v1');
  });

  it('defaults the port to 443 when only the host is set', async () => {
    const http = createFakeHttp([{ text: '{"items":[]}' }]);
    const runtime = createFakeRuntime({ env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' } });
    const options = { provider: 'kubernetes', namespace: 'default', token: 't', http } as const;
    const provider = createProvider(options, resolveOptions(options), runtime);

    await provider.resolve('billing');
    expect(http.calls[0].url).toContain('https://10.96.0.1:443/');
  });

  it('strips a trailing slash from an explicit apiServer', async () => {
    const http = createFakeHttp([{ text: '{"items":[]}' }]);
    const options = {
      provider: 'kubernetes',
      namespace: 'default',
      apiServer: 'https://api//',
      token: 't',
      http,
    } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());

    await provider.resolve('billing');
    expect(http.calls[0].url).toContain('https://api/apis/');
  });

  it('throws when neither apiServer nor KUBERNETES_SERVICE_HOST is available', () => {
    const options = { provider: 'kubernetes', namespace: 'default', token: 't' } as const;
    expect(() => createProvider(options, resolveOptions(options), createFakeRuntime()))
      .toThrow(DiscoveryUnavailableError);
    expect(() => createProvider(options, resolveOptions(options), createFakeRuntime()))
      .toThrow('KUBERNETES_SERVICE_HOST');
  });

  it('throws when an empty KUBERNETES_SERVICE_HOST is set', () => {
    const runtime = createFakeRuntime({ env: { KUBERNETES_SERVICE_HOST: '' } });
    const options = { provider: 'kubernetes', namespace: 'default', token: 't' } as const;
    expect(() => createProvider(options, resolveOptions(options), runtime))
      .toThrow(DiscoveryUnavailableError);
  });

  it('throws when there is neither a token nor a file system to read one from', () => {
    const options = {
      provider: 'kubernetes',
      namespace: 'default',
      apiServer: 'https://api',
    } as const;
    expect(() => createProvider(options, resolveOptions(options), createFakeRuntime()))
      .toThrow('IRuntimeServices.fs');
  });

  it('accepts a file system in place of an explicit token', () => {
    const runtime = createFakeRuntime({ fs: noopFs });
    const options = {
      provider: 'kubernetes',
      namespace: 'default',
      apiServer: 'https://api',
    } as const;
    expect(createProvider(options, resolveOptions(options), runtime))
      .toBeInstanceOf(KubernetesProvider);
  });
});

describe('createProvider — dns without a resolver', () => {
  it('throws naming Workers and the alternative arms', () => {
    const options = { provider: 'dns', mode: 'srv' } as const;
    const runtime = createFakeRuntime();
    expect(() => createProvider(options, resolveOptions(options), runtime))
      .toThrow(DiscoveryUnavailableError);
    expect(() => createProvider(options, resolveOptions(options), runtime))
      .toThrow('Cloudflare Workers');
  });

  it('threads the a-mode port through to the provider', async () => {
    const options = { provider: 'dns', mode: 'a', port: 9000 } as const;
    const runtime = createFakeRuntime({ dns: createFakeDns({ a: ['10.0.0.1'] }) });
    const provider = createProvider(options, resolveOptions(options), runtime);

    expect((await provider.resolve('billing'))[0].port).toBe(9000);
  });
});

describe('createProvider — optional options reach the provider', () => {
  it('threads the consul token, datacenter, and secure flag through', async () => {
    const http = createFakeHttp([{
      text: '[{"Node":{"Address":"10.0.0.9"},' +
        '"Service":{"ID":"b1","Service":"billing","Port":8080}}]',
    }]);
    const options = {
      provider: 'consul',
      address: 'http://consul:8500',
      token: 'secret',
      datacenter: 'dc2',
      secure: true,
      http,
    } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());

    const instances = await provider.resolve('billing');
    expect(http.calls[0].url).toContain('dc=dc2');
    expect(http.calls[0].init?.headers).toEqual({ 'X-Consul-Token': 'secret' });
    expect(instances[0].secure).toBe(true);
  });

  it('threads the kubernetes portName and secure flag through', async () => {
    const body = JSON.stringify({
      items: [{
        endpoints: [{ addresses: ['10.1.0.1'] }],
        ports: [{ name: 'http', port: 8080 }, { name: 'grpc', port: 9090 }],
      }],
    });
    const http = createFakeHttp([{ text: body }]);
    const options = {
      provider: 'kubernetes',
      namespace: 'default',
      apiServer: 'https://api',
      token: 't',
      portName: 'grpc',
      secure: true,
      http,
    } as const;
    const provider = createProvider(options, resolveOptions(options), createFakeRuntime());

    const [only] = await provider.resolve('billing');
    // Without portName reaching the provider this would throw on multi-port.
    expect(only.port).toBe(9090);
    expect(only.secure).toBe(true);
  });

  it('threads the dns domainTemplate and secure flag through', async () => {
    let queried = '';
    const runtime = createFakeRuntime({
      dns: {
        resolveSrv: (hostname: string) => {
          queried = hostname;
          return Promise.resolve([{ host: 'a.internal', port: 8080, priority: 0, weight: 1 }]);
        },
        resolveHost: () => Promise.resolve([]),
      },
    });
    const options = {
      provider: 'dns',
      mode: 'srv',
      domainTemplate: '_grpc._tcp.{service}.mesh',
      secure: true,
    } as const;
    const provider = createProvider(options, resolveOptions(options), runtime);

    const [only] = await provider.resolve('billing');
    expect(queried).toBe('_grpc._tcp.billing.mesh');
    expect(only.secure).toBe(true);
  });
});
