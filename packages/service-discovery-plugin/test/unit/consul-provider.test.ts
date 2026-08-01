/**
 * Unit tests for the Consul provider.
 *
 * The `Service.Address` fallback is the load-bearing case: Consul returns an
 * empty string for a service registered without an explicit address, and
 * omitting the node-address fallback yields `http://:8080`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ConsulProvider } from '../../src/providers/consul-provider.ts';
import { createFakeHttp, createFakeRuntime, type FakeHttp } from '../fixtures/fakes.ts';

function setup(
  options: Partial<ConstructorParameters<typeof ConsulProvider>[0]> = {},
  http: FakeHttp = createFakeHttp(),
): { provider: ConsulProvider; http: FakeHttp } {
  const provider = new ConsulProvider(
    { address: 'http://consul:8500', waitSeconds: 30, ...options },
    http,
    createFakeRuntime(),
  );
  return { provider, http };
}

const entry = {
  Node: { Address: '10.0.0.9' },
  Service: {
    ID: 'billing-1',
    Service: 'billing',
    Address: '10.0.0.1',
    Port: 8080,
    Tags: ['primary'],
    Meta: { zone: 'eu-1' },
    Weights: { Passing: 7 },
  },
};

describe('ConsulProvider — URL and headers', () => {
  it('always sends passing=true', () => {
    const { provider } = setup();
    expect(provider.healthUrl('billing')).toBe(
      'http://consul:8500/v1/health/service/billing?passing=true',
    );
  });

  it('appends the datacenter when configured', () => {
    const { provider } = setup({ datacenter: 'dc2' });
    expect(provider.healthUrl('billing')).toBe(
      'http://consul:8500/v1/health/service/billing?passing=true&dc=dc2',
    );
  });

  it('adds index and wait for a blocking query', () => {
    const { provider } = setup({ waitSeconds: 45 });
    expect(provider.healthUrl('billing', 17)).toBe(
      'http://consul:8500/v1/health/service/billing?passing=true&index=17&wait=45s',
    );
  });

  it('strips a trailing slash from the agent address', () => {
    const { provider } = setup({ address: 'http://consul:8500///' });
    expect(provider.healthUrl('billing')).toBe(
      'http://consul:8500/v1/health/service/billing?passing=true',
    );
  });

  it('sends X-Consul-Token when configured', () => {
    const { provider } = setup({ token: 'secret' });
    expect(provider.headers()).toEqual({ 'X-Consul-Token': 'secret' });
  });

  it('omits the header key entirely when no token is configured', () => {
    const { provider } = setup();
    expect('X-Consul-Token' in provider.headers()).toBe(false);
  });
});

describe('ConsulProvider — response mapping', () => {
  it('maps a full entry', () => {
    const { provider } = setup({ secure: true });
    expect(provider.mapEntries([entry], 'billing')).toEqual([
      {
        id: 'billing-1',
        serviceName: 'billing',
        host: '10.0.0.1',
        port: 8080,
        secure: true,
        weight: 7,
        tags: ['primary'],
        metadata: { zone: 'eu-1' },
      },
    ]);
  });

  it('falls back to Node.Address when Service.Address is an empty string', () => {
    const { provider } = setup();
    const [only] = provider.mapEntries(
      [{ ...entry, Service: { ...entry.Service, Address: '' } }],
      'billing',
    );
    expect(only.host).toBe('10.0.0.9');
  });

  it('falls back to Node.Address when Service.Address is absent', () => {
    const { provider } = setup();
    const [only] = provider.mapEntries(
      [{ Node: { Address: '10.0.0.9' }, Service: { Service: 'billing', Port: 8080 } }],
      'billing',
    );
    expect(only.host).toBe('10.0.0.9');
    expect(only.id).toBe('10.0.0.9:8080');
  });

  it('a populated Service.Address wins over the node address', () => {
    const { provider } = setup();
    const [only] = provider.mapEntries([entry], 'billing');
    expect(only.host).toBe('10.0.0.1');
  });

  it('skips entries with no port and no resolvable host', () => {
    const { provider } = setup();
    expect(provider.mapEntries(
      [
        { Service: { Service: 'billing' } },
        { Service: { Service: 'billing', Port: 8080 } },
        {},
      ],
      'billing',
    )).toEqual([]);
  });

  it('falls back to the requested name when the entry omits one', () => {
    const { provider } = setup();
    const [only] = provider.mapEntries(
      [{ Node: { Address: '10.0.0.9' }, Service: { Port: 8080 } }],
      'billing',
    );
    expect(only.serviceName).toBe('billing');
  });

  it('returns an empty list for a non-array body', () => {
    const { provider } = setup();
    expect(provider.mapEntries({ error: 'nope' }, 'billing')).toEqual([]);
  });
});

describe('ConsulProvider — resolve', () => {
  it('reads the health endpoint and maps the result', async () => {
    const http = createFakeHttp([{ text: JSON.stringify([entry]) }]);
    const { provider } = setup({}, http);

    const instances = await provider.resolve('billing');
    expect(instances.map((i) => i.id)).toEqual(['billing-1']);
    expect(http.calls[0].url).toContain('passing=true');
  });

  it('rejects on a non-2xx response', async () => {
    const http = createFakeHttp([{ status: 500, text: 'boom' }]);
    const { provider } = setup({}, http);
    await expect(provider.resolve('billing')).rejects.toThrow('HTTP 500');
  });
});

describe('ConsulProvider — self registration', () => {
  const registration = {
    serviceName: 'orders',
    id: 'orders-1',
    address: '10.0.0.7',
    port: 3000,
    tags: ['v2'],
    metadata: { region: 'eu' },
    check: { httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 },
  };

  it('PUTs the registration with the check built from the defaults', async () => {
    const http = createFakeHttp([{ text: '' }]);
    const { provider } = setup({}, http);

    await provider.registerSelf(registration);

    expect(http.calls[0].url).toBe('http://consul:8500/v1/agent/service/register');
    expect(http.calls[0].init?.method).toBe('PUT');
    expect(JSON.parse(String(http.calls[0].init?.body))).toEqual({
      ID: 'orders-1',
      Name: 'orders',
      Address: '10.0.0.7',
      Port: 3000,
      Tags: ['v2'],
      Meta: { region: 'eu' },
      Check: {
        HTTP: 'http://10.0.0.7:3000/health',
        Interval: '10s',
        DeregisterCriticalServiceAfter: '60s',
      },
    });
  });

  it('builds an https check URL when secure is set', async () => {
    const http = createFakeHttp([{ text: '' }]);
    const { provider } = setup({ secure: true }, http);

    await provider.registerSelf(registration);
    const body = JSON.parse(String(http.calls[0].init?.body));
    expect(body.Check.HTTP).toBe('https://10.0.0.7:3000/health');
  });

  it('omits Tags, Meta, and Check when the registration carries none', async () => {
    const http = createFakeHttp([{ text: '' }]);
    const { provider } = setup({}, http);

    await provider.registerSelf({ serviceName: 'orders', address: '10.0.0.7', port: 3000 });
    const body = JSON.parse(String(http.calls[0].init?.body));
    expect('Tags' in body).toBe(false);
    expect('Meta' in body).toBe(false);
    expect('Check' in body).toBe(false);
  });

  it('generates a stable id when none is given, and reuses it on deregister', async () => {
    const http = createFakeHttp([{ text: '' }, { text: '' }]);
    const { provider } = setup({}, http);
    const anonymous = { serviceName: 'orders', address: '10.0.0.7', port: 3000 };

    await provider.registerSelf(anonymous);
    await provider.deregisterSelf(anonymous);

    const id = JSON.parse(String(http.calls[0].init?.body)).ID as string;
    expect(id).toBe('orders-uuid-0');
    // Deregistering must target the id that was actually registered — a fresh
    // uuid here would leave the instance advertised forever.
    expect(http.calls[1].url).toBe(`http://consul:8500/v1/agent/service/deregister/${id}`);
  });

  it('deregisters by instance id', async () => {
    const http = createFakeHttp([{ text: '' }]);
    const { provider } = setup({}, http);

    await provider.deregisterSelf(registration);
    expect(http.calls[0].url).toBe(
      'http://consul:8500/v1/agent/service/deregister/orders-1',
    );
    expect(http.calls[0].init?.method).toBe('PUT');
  });

  it('rejects when registration or deregistration is refused', async () => {
    const http = createFakeHttp([{ status: 403, text: 'denied' }]);
    const { provider } = setup({}, http);
    await expect(provider.registerSelf(registration)).rejects.toThrow('HTTP 403');

    const http2 = createFakeHttp([{ status: 500, text: 'boom' }]);
    const { provider: p2 } = setup({}, http2);
    await expect(p2.deregisterSelf(registration)).rejects.toThrow('HTTP 500');
  });

  it('reports the backend id', () => {
    expect(setup().provider.kind).toBe('consul');
  });
});
