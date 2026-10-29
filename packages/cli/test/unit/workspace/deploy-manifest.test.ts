import { describe, expect, it } from 'vitest';

import {
  prepareDeployManifest,
  readsMemberSecret,
  stampSecretVersion,
} from '../../../src/workspace/deploy-manifest.ts';
import { workspaceK8sFiles } from '../../../src/workspace/k8s.ts';
import { WORKSPACE_VERSION } from '../../../src/workspace/manifest.ts';
import { transportSpec } from '../../../src/workspace/transport.ts';
import { envFromBlock } from '../../../src/workspace/secrets.ts';

const MANIFEST = `metadata:
  namespace: \${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: \${WORKSPACE}
spec:
  containers:
    - name: orders
      # docker build ... -t orders:dev .
      image: orders:dev
    - name: orders-api
      image: orders-api:dev
`;

describe('prepareDeployManifest', () => {
  it('fills both placeholders and points each member at its image', () => {
    const result = prepareDeployManifest(MANIFEST, {
      namespace: 'shop',
      workspace: 'acme',
      images: new Map([
        ['orders', 'r.io/orders:abc'],
        ['orders-api', 'r.io/orders-api:abc'],
      ]),
    });
    expect(result).toEqual({
      ok: true,
      text: MANIFEST.replace('${NAMESPACE}', 'shop')
        .replace('${WORKSPACE}', 'acme')
        .replace('image: orders:dev', 'image: r.io/orders:abc')
        .replace('image: orders-api:dev', 'image: r.io/orders-api:abc'),
    });
  });

  it('refuses a member with no generated image line, or with two', () => {
    const none = prepareDeployManifest(MANIFEST, {
      namespace: 'shop',
      workspace: 'acme',
      images: new Map([['billing', 'billing:abc']]),
    });
    expect(none).toEqual({
      ok: false,
      message: expect.stringContaining('has no `image: billing:dev` line'),
    });

    const twice = prepareDeployManifest(`${MANIFEST}      image: orders:dev\n`, {
      namespace: 'shop',
      workspace: 'acme',
      images: new Map([['orders', 'orders:abc']]),
    });
    expect(twice).toEqual({
      ok: false,
      message: expect.stringContaining('has 2 `image: orders:dev` lines'),
    });
  });

  it('refuses a placeholder it does not fill', () => {
    const result = prepareDeployManifest(`${MANIFEST}# \${REGION}\n`, {
      namespace: 'shop',
      workspace: 'acme',
      images: new Map(),
    });
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('still contains ${REGION}'),
    });
  });
});

describe('readsMemberSecret', () => {
  it('finds the generated block and a quoted hand-written one, and only for its member', () => {
    expect(readsMemberSecret(envFromBlock('portal'), 'portal')).toBe(true);
    expect(
      readsMemberSecret("envFrom:\n  - secretRef:\n      name: 'portal-env'\n", 'portal'),
    ).toBe(true);
    expect(readsMemberSecret(envFromBlock('portal'), 'orders')).toBe(false);
    expect(readsMemberSecret(envFromBlock('portal-env-extra'), 'portal')).toBe(false);
    expect(readsMemberSecret('image: portal:dev\n', 'portal')).toBe(false);
  });
});

describe('stampSecretVersion (re-audit N2)', () => {
  const yaml = workspaceK8sFiles(
    {
      version: WORKSPACE_VERSION,
      runtime: 'node',
      basePort: 3000,
      transport: 'http',
      members: [
        { name: 'portal', port: 3000 },
        { name: 'portal-admin', port: 3001 },
      ],
    },
    transportSpec('http'),
  ).find((file) => file.path === 'k8s/members.yaml')!.contents;

  it("fills only the member's own Deployment slot", () => {
    const stamped = stampSecretVersion(yaml, 'portal', '42');
    expect(stamped.stamped).toBe(true);
    expect(stamped.text.match(/setu-ts\.dev\/secret-version: '42'/g)).toHaveLength(1);
    const admin = stamped.text
      .split(/^---$/m)
      .find((doc) => doc.includes('name: portal-admin\n') && doc.includes('kind: Deployment'));
    expect(admin).toContain("setu-ts.dev/secret-version: ''");
    // Re-stamping replaces the value rather than adding a line.
    const again = stampSecretVersion(stamped.text, 'portal', '43');
    expect(again.text.match(/secret-version: '4[23]'/g)).toEqual(["secret-version: '43'"]);
  });

  it('reports a manifest without the slot, and a member it does not contain', () => {
    const old = yaml.replace(/^ +setu-ts\.dev\/secret-version: ''\n/gm, '');
    expect(stampSecretVersion(old, 'portal', '1')).toEqual({ text: old, stamped: false });
    expect(stampSecretVersion(yaml, 'billing', '1').stamped).toBe(false);
  });
});

describe('newline-safe matching (re-audit N3)', () => {
  it('stays linear on a members.yaml of blank lines', () => {
    const hostile = `${'\n'.repeat(200_000)}image: x\n`;
    const started = performance.now();
    prepareDeployManifest(hostile, {
      namespace: 'n',
      workspace: 'w',
      images: new Map([['orders', 'o:1']]),
    });
    readsMemberSecret(`secretRef:${'\n'.repeat(200_000)}`, 'orders');
    // The quadratic patterns took 0.8 s at 40k newlines; 200k linear lines take milliseconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
