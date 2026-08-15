import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { K8S_DIR, workspaceK8sFiles } from '../../../src/workspace/k8s.ts';
import { WORKSPACE_VERSION, type WorkspaceManifest } from '../../../src/workspace/manifest.ts';
import { type TransportName, transportSpec } from '../../../src/workspace/transport.ts';

/**
 * Builds a manifest holding the given members.
 *
 * @param members - Name/port pairs
 * @param transport - The workspace's transport
 * @returns The manifest
 */
function manifestOf(
  members: readonly { name: string; port: number }[],
  transport: TransportName = 'http',
): WorkspaceManifest {
  return { version: WORKSPACE_VERSION, runtime: 'deno', basePort: 3000, transport, members };
}

/**
 * Renders the objects for a workspace and returns the manifest document.
 *
 * @param members - Name/port pairs
 * @param transport - The workspace's transport
 * @returns The contents of `k8s/members.yaml`
 */
function objectsFor(
  members: readonly { name: string; port: number }[],
  transport: TransportName = 'http',
): string {
  const files = workspaceK8sFiles(manifestOf(members, transport), transportSpec(transport));
  const file = files.find((candidate) => candidate.path === `${K8S_DIR}/members.yaml`);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('workspaceK8sFiles', () => {
  it('emits the objects and a README, both managed', () => {
    const files = workspaceK8sFiles(
      manifestOf([{ name: 'orders', port: 3000 }]),
      transportSpec('http'),
    );
    expect(files.map((f) => f.path)).toEqual([`${K8S_DIR}/members.yaml`, `${K8S_DIR}/README.md`]);
    for (const file of files) expect(file.managed).toBe(true);
  });

  // A memberless workspace has nothing to deploy, and an empty document that
  // `kubectl apply` accepts silently is worse than no file.
  it('emits nothing for a workspace with no members', () => {
    expect(workspaceK8sFiles(manifestOf([]), transportSpec('http'))).toEqual([]);
  });

  it('gives every member a Deployment and a Service on its allocated port', () => {
    const yaml = objectsFor([{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }]);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('name: orders');
    expect(yaml).toContain('name: billing');
    expect(yaml).toContain('containerPort: 3000');
    expect(yaml).toContain('containerPort: 3001');
  });

  // M39's cluster finding: `runAsNonRoot` REFUSES an image whose user is a name —
  // "cannot verify user is non-root" — and Docker resolves it happily, so this
  // fails only once deployed.
  it('runs as a numeric non-root user', () => {
    const yaml = objectsFor([{ name: 'orders', port: 3000 }]);
    expect(yaml).toContain('runAsNonRoot: true');
    expect(yaml).toContain('runAsUser: 1000');
    expect(yaml).not.toContain('runAsUser: deno');
  });

  // M39's other cluster finding: an emptyDir over the module-cache directory MASKS
  // the cache baked in at build time, and every pod then re-resolves from the
  // network at startup — fatal in an air-gapped cluster.
  it('mounts only /tmp, never over the module cache', () => {
    const yaml = objectsFor([{ name: 'orders', port: 3000 }]);
    expect(yaml).toContain('mountPath: /tmp');
    expect(yaml).not.toContain('/deno-dir');
  });

  // An object whose namespace is left implicit applies into whichever one happens
  // to be current — which is how a RoleBinding ends up granting nothing.
  it('pins the namespace on every object', () => {
    const yaml = objectsFor([{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }]);
    const namespaces = yaml.match(/namespace: /g) ?? [];
    // Two objects per member, two members.
    expect(namespaces.length).toBe(4);
  });

  // Only real because the generated entry installs a SIGTERM handler.
  it('gives every pod a termination grace period', () => {
    expect(objectsFor([{ name: 'orders', port: 3000 }])).toContain(
      'terminationGracePeriodSeconds: 30',
    );
  });

  // `/live` and `/ready` exist only when the member registers HealthPlugin, which
  // depends on its template — an HTTP probe against a member without one would
  // fail readiness forever, so the generated probe is transport-agnostic.
  it('probes the socket rather than a health path it cannot guarantee', () => {
    const yaml = objectsFor([{ name: 'orders', port: 3000 }]);
    expect(yaml).toContain('tcpSocket:');
    // The DIRECTIVE, not the substring: the file names the upgrade in a comment,
    // so a bare check fails on its own explanation.
    expect(yaml).not.toMatch(/^\s+httpGet:/m);
    expect(yaml).toContain('httpGet: { path: /ready, port: http }');
  });

  // The same property the Compose stack needs, for the same reason: in a cluster a
  // sibling is its Service name, and the generated map's fallback is loopback.
  // Proven against a real kind cluster — `http://billing:8101/` answered 200, and
  // deleting the Service made the same request fail.
  it('gives every member its siblings host, by service name', () => {
    const yaml = objectsFor([
      { name: 'orders', port: 3000 },
      { name: 'billing', port: 3001 },
    ]);
    expect(yaml).toContain('- name: BILLING_HOST');
    expect(yaml).toContain("value: 'billing'");
    expect(yaml).toContain('- name: ORDERS_HOST');
  });

  it('carries the transport connection variable too', () => {
    const yaml = objectsFor([{ name: 'orders', port: 3000 }], 'redis');
    expect(yaml).toContain('- name: REDIS_URL');
    expect(yaml).toContain("value: 'redis://redis:6379'");
  });

  // A guessed Ingress silently routes nothing, and a broker for a cluster is a
  // managed service rather than the single dev container Compose runs — so both are
  // named as absent rather than emitted wrong.
  it('says what it deliberately leaves out', () => {
    const files = workspaceK8sFiles(
      manifestOf([{ name: 'orders', port: 3000 }], 'redis'),
      transportSpec('redis'),
    );
    const readme = files.find((f) => f.path === `${K8S_DIR}/README.md`)?.contents ?? '';
    expect(readme).toContain('An Ingress');
    expect(readme).toContain('backing service');
    expect(readme).toContain('envsubst');
  });

  it('sorts members so a reordered manifest is not a diff', () => {
    const yaml = objectsFor([{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }]);
    expect(yaml.indexOf('# billing')).toBeLessThan(yaml.indexOf('# orders'));
  });
});

// X2-7. Every generated Deployment used a TCP probe plus a comment telling the
// developer to switch to `httpGet` "once" the member registers HealthPlugin — a
// decision the generator already holds the answer to, since the template is an
// argument to `setu generate app` and the manifest is rendered per member.
describe('probe selection', () => {
  /** Renders the deployment for one member. */
  const render = (member: { name: string; port: number; healthProbes?: boolean }): string => {
    const files = workspaceK8sFiles(
      {
        version: 1,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [member],
      },
      transportSpec('http'),
    );
    return files.find((file) => file.path.endsWith('members.yaml'))?.contents ?? '';
  };

  /** The probe kind a rendered Deployment declares, read structurally. */
  const probeKinds = (yaml: string): readonly string[] =>
    [...yaml.matchAll(/(readiness|liveness)Probe:\n\s+(\w+):/g)].map((match) => match[2] ?? '');

  it('uses HTTP probes for a member generated WITH a template', () => {
    const yaml = render({ name: 'orders', port: 3000, healthProbes: true });

    expect(probeKinds(yaml)).toEqual(['httpGet', 'httpGet']);
    expect(yaml).toContain('path: /ready');
    expect(yaml).toContain('path: /live');
  });

  it('keeps the TCP probe for a template-less member, which serves neither path', () => {
    // Pointing a probe at a 404 would make the member permanently unready, so
    // this arm is a real requirement rather than caution.
    const yaml = render({ name: 'orders', port: 3000, healthProbes: false });

    expect(probeKinds(yaml)).toEqual(['tcpSocket', 'tcpSocket']);
  });

  it('treats an ABSENT record as unknown, not as yes', () => {
    // A workspace created before M70h carries no such field. Falling back to the
    // TCP probe keeps those manifests working rather than pointing a probe at a
    // path the member may not serve.
    expect(probeKinds(render({ name: 'orders', port: 3000 }))).toEqual([
      'tcpSocket',
      'tcpSocket',
    ]);
  });
});
