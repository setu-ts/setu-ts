/**
 * Unit tests for the Kubernetes provider.
 *
 * The token-rotation case is the one that only bites in production:
 * Kubernetes rotates projected service-account tokens roughly hourly, so a
 * token read once at startup stops working while the pod is still healthy.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { KubernetesProvider } from '../../src/providers/kubernetes-provider.ts';
import { DiscoveryUnavailableError } from '../../src/errors.ts';
import type { IFileSystem } from '@hono-enterprise/common';
import {
  createFakeHttp,
  createFakeRuntime,
  type FakeHttp,
  type FakeRuntime,
} from '../fixtures/fakes.ts';

/** A file system that records reads and answers with a scripted token. */
function tokenFs(values: string[]): { fs: IFileSystem; paths: string[] } {
  const paths: string[] = [];
  let index = 0;
  const fs = {
    readFile(path: string): Promise<Uint8Array> {
      paths.push(path);
      const value = values[Math.min(index++, values.length - 1)];
      return Promise.resolve(new TextEncoder().encode(value));
    },
    writeFile: () => Promise.resolve(),
    stat: () => Promise.reject(new Error('not used')),
    readdir: () => Promise.resolve([] as readonly string[]),
    mkdir: () => Promise.resolve(),
    rm: () => Promise.resolve(),
  } as IFileSystem;
  return { fs, paths };
}

function setup(
  options: Partial<ConstructorParameters<typeof KubernetesProvider>[0]> = {},
  http: FakeHttp = createFakeHttp(),
  runtime: FakeRuntime = createFakeRuntime(),
): { provider: KubernetesProvider; http: FakeHttp; runtime: FakeRuntime } {
  const provider = new KubernetesProvider(
    { namespace: 'default', apiServer: 'https://api', ...options },
    http,
    runtime,
  );
  return { provider, http, runtime };
}

const slice = {
  items: [{
    endpoints: [{ addresses: ['10.1.0.1', '10.1.0.2'], conditions: { ready: true } }],
    ports: [{ name: 'http', port: 8080 }],
  }],
  metadata: { resourceVersion: '100' },
};

describe('KubernetesProvider — URL', () => {
  it('builds the EndpointSlice list URL with the service-name label selector', () => {
    const { provider } = setup();
    expect(provider.listUrl('billing')).toBe(
      'https://api/apis/discovery.k8s.io/v1/namespaces/default/endpointslices' +
        '?labelSelector=kubernetes.io%2Fservice-name%3Dbilling',
    );
  });

  it('appends extra query parameters', () => {
    const { provider } = setup();
    const url = provider.listUrl('billing', { watch: 'true', resourceVersion: '9' });
    expect(url).toContain('watch=true');
    expect(url).toContain('resourceVersion=9');
  });
});

describe('KubernetesProvider — token resolution', () => {
  it('uses an explicit token verbatim and never touches the file system', async () => {
    const { fs, paths } = tokenFs(['from-disk']);
    const { provider } = setup(
      { token: 'explicit' },
      createFakeHttp(),
      createFakeRuntime({ fs }),
    );
    expect(await provider.authHeader()).toBe('Bearer explicit');
    expect(paths).toEqual([]);
  });

  it('reads the projected service-account token and decodes it as UTF-8', async () => {
    const { fs, paths } = tokenFs(['disk-token\n']);
    const { provider } = setup({}, createFakeHttp(), createFakeRuntime({ fs }));

    expect(await provider.authHeader()).toBe('Bearer disk-token');
    expect(paths).toEqual(['/var/run/secrets/kubernetes.io/serviceaccount/token']);
  });

  it('reads the token once across two calls inside the memo window', async () => {
    const { fs, paths } = tokenFs(['first', 'second']);
    const runtime = createFakeRuntime({ fs });
    const { provider } = setup({}, createFakeHttp(), runtime);

    await provider.authHeader();
    runtime.advance(59_000);
    expect(await provider.authHeader()).toBe('Bearer first');
    expect(paths).toHaveLength(1);
  });

  it('re-reads the token once the memo window has elapsed', async () => {
    const { fs, paths } = tokenFs(['first', 'second']);
    const runtime = createFakeRuntime({ fs });
    const { provider } = setup({}, createFakeHttp(), runtime);

    await provider.authHeader();
    runtime.advance(60_001);
    expect(await provider.authHeader()).toBe('Bearer second');
    expect(paths).toHaveLength(2);
  });

  it('sends the bearer token on the list request', async () => {
    const http = createFakeHttp([{ text: JSON.stringify(slice) }]);
    const { provider } = setup({ token: 'explicit' }, http);

    await provider.resolve('billing');
    expect(http.calls[0].init?.headers).toEqual({ Authorization: 'Bearer explicit' });
  });
});

describe('KubernetesProvider — EndpointSlice mapping', () => {
  it('emits one instance per address', () => {
    const { provider } = setup();
    expect(provider.mapSlices(slice, 'billing')).toEqual([
      { id: '10.1.0.1:8080', serviceName: 'billing', host: '10.1.0.1', port: 8080, secure: false },
      { id: '10.1.0.2:8080', serviceName: 'billing', host: '10.1.0.2', port: 8080, secure: false },
    ]);
  });

  it('treats a missing conditions.ready as READY, per the API reference', () => {
    const { provider } = setup();
    const body = {
      items: [{ endpoints: [{ addresses: ['10.1.0.1'] }], ports: [{ port: 8080 }] }],
    };
    expect(provider.mapSlices(body, 'billing')).toHaveLength(1);
  });

  it('excludes an endpoint whose conditions.ready is false', () => {
    const { provider } = setup();
    const body = {
      items: [{
        endpoints: [
          { addresses: ['10.1.0.1'], conditions: { ready: false } },
          { addresses: ['10.1.0.2'], conditions: { ready: true } },
        ],
        ports: [{ port: 8080 }],
      }],
    };
    expect(provider.mapSlices(body, 'billing').map((i) => i.host)).toEqual(['10.1.0.2']);
  });

  it('carries secure through onto the instances', () => {
    const { provider } = setup({ secure: true });
    expect(provider.mapSlices(slice, 'billing')[0].secure).toBe(true);
  });

  it('uses the single declared port when portName is unset', () => {
    const { provider } = setup();
    expect(provider.mapSlices(slice, 'billing')[0].port).toBe(8080);
  });

  it('selects the named port when several exist', () => {
    const { provider } = setup({ portName: 'grpc' });
    const body = {
      items: [{
        endpoints: [{ addresses: ['10.1.0.1'] }],
        ports: [{ name: 'http', port: 8080 }, { name: 'grpc', port: 9090 }],
      }],
    };
    expect(provider.mapSlices(body, 'billing')[0].port).toBe(9090);
  });

  it('throws naming the available ports when several exist and none was named', () => {
    const { provider } = setup();
    const body = {
      items: [{
        endpoints: [{ addresses: ['10.1.0.1'] }],
        ports: [{ name: 'http', port: 8080 }, { name: 'grpc', port: 9090 }],
      }],
    };
    expect(() => provider.mapSlices(body, 'billing')).toThrow(DiscoveryUnavailableError);
    expect(() => provider.mapSlices(body, 'billing')).toThrow('grpc');
  });

  it('names an unnamed port in the multi-port error', () => {
    const { provider } = setup();
    const body = {
      items: [{
        endpoints: [{ addresses: ['10.1.0.1'] }],
        ports: [{ port: 8080 }, { port: 9090 }],
      }],
    };
    expect(() => provider.mapSlices(body, 'billing')).toThrow('<unnamed>');
  });

  it('skips a slice whose named port is absent', () => {
    const { provider } = setup({ portName: 'grpc' });
    const body = {
      items: [{ endpoints: [{ addresses: ['10.1.0.1'] }], ports: [{ name: 'http', port: 8080 }] }],
    };
    expect(provider.mapSlices(body, 'billing')).toEqual([]);
  });

  it('skips a slice that declares no port', () => {
    const { provider } = setup();
    const body = { items: [{ endpoints: [{ addresses: ['10.1.0.1'] }], ports: [] }] };
    expect(provider.mapSlices(body, 'billing')).toEqual([]);
  });

  it('handles a response with no items and endpoints with no addresses', () => {
    const { provider } = setup();
    expect(provider.mapSlices({}, 'billing')).toEqual([]);
    expect(provider.mapSlices({ items: [{ ports: [{ port: 1 }] }] }, 'billing')).toEqual([]);
    expect(
      provider.mapSlices({ items: [{ endpoints: [{}], ports: [{ port: 1 }] }] }, 'billing'),
    ).toEqual([]);
  });
});

describe('KubernetesProvider — resolve', () => {
  it('reads and maps the list', async () => {
    const http = createFakeHttp([{ text: JSON.stringify(slice) }]);
    const { provider } = setup({ token: 't' }, http);
    expect((await provider.resolve('billing')).map((i) => i.host))
      .toEqual(['10.1.0.1', '10.1.0.2']);
  });

  it('rejects on a non-2xx response', async () => {
    const http = createFakeHttp([{ status: 403, text: 'forbidden' }]);
    const { provider } = setup({ token: 't' }, http);
    await expect(provider.resolve('billing')).rejects.toThrow('HTTP 403');
  });

  it('reports the backend id', () => {
    expect(setup().provider.kind).toBe('kubernetes');
  });
});

describe('KubernetesProvider — watch wiring', () => {
  it('LISTs through the provider and delivers mapped instances', async () => {
    const http = createFakeHttp([
      { text: JSON.stringify(slice) },
      { chunks: [] },
    ]);
    const { provider } = setup({ token: 't' }, http);

    let unsubscribe: () => void = () => {};
    const seen = await new Promise<readonly { host: string }[]>((resolve) => {
      void provider.watch('billing', (instances) => resolve(instances))
        .then((stop) => {
          unsubscribe = stop;
        });
    });
    unsubscribe();

    expect(seen.map((i) => i.host)).toEqual(['10.1.0.1', '10.1.0.2']);
    expect(http.calls[0].url).toContain('labelSelector=kubernetes.io%2Fservice-name%3Dbilling');
    expect(http.calls[0].init?.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('watches from the resourceVersion the LIST reported', async () => {
    const http = createFakeHttp([
      { text: JSON.stringify(slice) },
      { chunks: [] },
    ]);
    const { provider } = setup({ token: 't' }, http);

    const unsubscribe = await provider.watch('billing', () => {});
    // Let the LIST settle and the watch open.
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    unsubscribe();

    const watchCall = http.calls.find((c) => c.streaming);
    expect(watchCall?.url).toContain('resourceVersion=100');
  });

  it('watches from an empty version when the LIST reports none', async () => {
    const http = createFakeHttp([
      { text: JSON.stringify({ items: [] }) },
      { chunks: [] },
    ]);
    const { provider } = setup({ token: 't' }, http);

    const unsubscribe = await provider.watch('billing', () => {});
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    unsubscribe();

    const watchCall = http.calls.find((c) => c.streaming);
    expect(watchCall?.url).toContain('resourceVersion=');
  });
});
