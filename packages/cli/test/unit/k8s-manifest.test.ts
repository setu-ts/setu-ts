/**
 * X10-4 and X10-6: the generated Deployment carries the chart's `preStop`
 * sleep, and the pod template carries Prometheus discovery annotations for
 * members the manifest records as serving `/metrics`.
 *
 * The chart ships both; the generated manifests shipped neither — drift
 * between two committed artifacts, not a difference of opinion. ABSENT
 * `metricsEndpoint` (a pre-M70l manifest) means "unknown" and emits nothing,
 * exactly like `healthProbes` falling back to a TCP probe.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { K8S_DIR, workspaceK8sFiles } from '../../src/workspace/k8s.ts';
import {
  WORKSPACE_VERSION,
  type WorkspaceManifest,
  type WorkspaceMember,
} from '../../src/workspace/manifest.ts';
import { transportSpec } from '../../src/workspace/transport.ts';

/** Renders members.yaml for one member with the given record. */
function render(member: WorkspaceMember): string {
  const manifest: WorkspaceManifest = {
    version: WORKSPACE_VERSION,
    runtime: 'deno',
    basePort: 3000,
    transport: 'http',
    members: [member],
  };
  const files = workspaceK8sFiles(manifest, transportSpec('http'));
  return files.find((f: { path: string; contents: string }) => f.path === `${K8S_DIR}/members.yaml`)
    ?.contents ?? '';
}

describe('generated Kubernetes manifests', () => {
  describe('preStop sleep (X10-4)', () => {
    it('carries lifecycle.preStop.sleep.seconds: 5 with its kube-proxy comment', () => {
      const yaml = render({ name: 'orders', port: 3000 });

      expect(yaml).toContain('lifecycle:');
      expect(yaml).toContain('preStop:');
      expect(yaml).toContain('sleep:');
      expect(yaml).toContain('seconds: 5');
      // The comment mirrors the chart's: WHY the sleep exists.
      expect(yaml).toContain('kube-proxy');
      expect(yaml).toContain('SIGTERM is not sent until this returns');
    });

    it('notes the Kubernetes version requirement', () => {
      const yaml = render({ name: 'orders', port: 3000 });
      expect(yaml).toContain('1.30+');
    });
  });

  describe('Prometheus annotations (X10-6)', () => {
    it('emits scrape/port/path for a member with metricsEndpoint: true', () => {
      const yaml = render({ name: 'orders', port: 3001, metricsEndpoint: true });

      // Single-quoted scalars: what `deno fmt` normalises the YAML to, so a
      // generated project is fmt-clean on the first run.
      expect(yaml).toContain("prometheus.io/scrape: 'true'");
      expect(yaml).toContain("prometheus.io/port: '3001'");
      expect(yaml).toContain("prometheus.io/path: '/metrics'");
      // Annotations live on the POD TEMPLATE metadata, not the object's.
      const templateMeta = yaml.slice(yaml.indexOf('template:'));
      expect(templateMeta).toContain("prometheus.io/scrape: 'true'");
    });

    it('emits none for metricsEndpoint: false', () => {
      const yaml = render({ name: 'orders', port: 3000, metricsEndpoint: false });
      expect(yaml).not.toContain('prometheus.io/');
    });

    it('emits none when the field is absent (a pre-M70l manifest)', () => {
      // Annotating a member that serves no /metrics makes Prometheus report a
      // permanently-down target — worse than not discovering it.
      const yaml = render({ name: 'orders', port: 3000 });
      expect(yaml).not.toContain('prometheus.io/');
    });
  });

  it('the generated README names the annotations and the member port', () => {
    const manifest: WorkspaceManifest = {
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members: [{ name: 'orders', port: 3000, metricsEndpoint: true }],
    };
    const files = workspaceK8sFiles(manifest, transportSpec('http'));
    const readme =
      files.find((f: { path: string; contents: string }) => f.path === `${K8S_DIR}/README.md`)
        ?.contents ?? '';

    expect(readme).toContain('prometheus.io/scrape');
    expect(readme).toContain('/metrics');
  });
});
