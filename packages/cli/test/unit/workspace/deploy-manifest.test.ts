import { describe, expect, it } from 'vitest';

import {
  prepareDeployManifest,
  readsMemberSecret,
  stampSecretVersion,
  unreadableSlot,
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

  it('splits on commented separators and refuses ambiguity (audit 3, L2)', () => {
    const commented = yaml.replace(/^---$/gm, '--- # next object');
    const stamped = stampSecretVersion(commented, 'portal', '42');
    expect(stamped.stamped).toBe(true);
    expect(stamped.text.match(/secret-version: '42'/g)).toHaveLength(1);
    expect(stamped.text.match(/^--- # next object$/gm)).toHaveLength(
      commented.match(/^--- # next object$/gm)!.length,
    );
    const portal = stamped.text
      .split(/^---.*$/m)
      .find((doc) => doc.includes('kind: Deployment') && /^ {2}name: portal$/m.test(doc));
    expect(portal).toContain("secret-version: '42'");

    // A decoy Deployment with the same name: two owners, so no stamp and the caller falls back.
    const decoy = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: portal\n  namespace: other\nspec:\n  template:\n    metadata:\n      annotations:\n        setu-ts.dev/secret-version: ''\n---\n${yaml}`;
    expect(stampSecretVersion(decoy, 'portal', '42')).toEqual({ text: decoy, stamped: false });

    // A second slot in the same document (the Deployment's own metadata): ambiguous, refused.
    const twice = yaml.replace(
      /(kind: Deployment\nmetadata:\n {2}name: portal\n)/,
      "$1  annotations:\n        setu-ts.dev/secret-version: ''\n",
    );
    expect(stampSecretVersion(twice, 'portal', '42').stamped).toBe(false);

    // A slot at the wrong indent is not the pod template's.
    const shallow = yaml.replace(
      /^ {8}setu-ts\.dev\/secret-version/gm,
      '      setu-ts.dev/secret-version',
    );
    expect(stampSecretVersion(shallow, 'portal', '42').stamped).toBe(false);
  });

  it("splits documents by kubectl's rule and refuses a document with two kinds (audit 4, A4-1)", () => {
    for (const separator of ['---#x', '--- ', '---\f', '--- # c']) {
      const split = yaml.replace(/^---$/gm, separator);
      const stamped = stampSecretVersion(split, 'portal', '42');
      expect(stamped.stamped, JSON.stringify(separator)).toBe(true);
      const portal = stamped.text
        .split(/^---.*$/m)
        .find((doc) => doc.includes('kind: Deployment') && /^ {2}name: portal$/m.test(doc));
      expect(portal, JSON.stringify(separator)).toContain("secret-version: '42'");
    }
    // `--- foo` is not a separator for kubectl, so the documents it would join are refused.
    const joined = yaml.replace(/^---$/m, '--- foo');
    expect(stampSecretVersion(joined, 'orders', '1').stamped).toBe(false);
    // A block scalar holding a column-0 `kind:` line: two kinds, refused.
    const scalar = yaml.replace(
      /(kind: Deployment\nmetadata:\n {2}name: portal\n)/,
      '$1  annotations:\n    note: |\nkind: Service\n',
    );
    expect(stampSecretVersion(scalar, 'portal', '1').stamped).toBe(false);
  });

  it('refuses a slot it cannot fill, and accepts a generated or absent one (audit 6, A6-1)', () => {
    expect(unreadableSlot(yaml, 'portal')).toBeUndefined();
    const absent = yaml.replace(/^ +setu-ts\.dev\/secret-version: ''\n/gm, '');
    expect(unreadableSlot(absent, 'portal')).toBeUndefined();
    const flow = yaml.replace(
      /^ {6}annotations:\n {8}# Set by[^\n]*\n {8}setu-ts\.dev\/secret-version: ''\n/m,
      "      annotations: {setu-ts.dev/secret-version: ''}\n",
    );
    const shallow = yaml.replace(
      /^ {8}setu-ts\.dev\/secret-version/m,
      '          setu-ts.dev/secret-version',
    );
    const twice = yaml.replace(
      /^( {8}setu-ts\.dev\/secret-version: ''\n)/m,
      "$1        setu-ts.dev/secret-version: ''\n",
    );
    // Spellings the stamp does not read, each carrying the flow-style slot (audit 7, A7-1).
    const owner = /(kind: Deployment\nmetadata:\n {2})name: portal\n/;
    const quotedName = flow.replace(owner, "$1name: 'portal'\n");
    const commentedName = flow.replace(owner, '$1name: portal # web\n');
    const quotedKind = flow.replace(
      /kind: Deployment(\nmetadata:\n {2}name: portal\n)/,
      'kind: "Deployment"$1',
    );
    const escapedKey = yaml.replace(
      /^( {8})setu-ts\.dev\/secret-version(: '')/m,
      '$1"setu-ts.dev\\/secret-version"$2',
    );
    for (const [label, text] of [
      ['flow', flow],
      ['indent', shallow],
      ['twice', twice],
      ['quoted name', quotedName],
      ['commented name', commentedName],
      ['quoted kind', quotedKind],
      ['escaped key', escapedKey],
    ] as const) {
      expect(text, label).not.toBe(yaml);
      expect(unreadableSlot(text, 'portal'), label).toContain('that deploy cannot fill');
    }
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
