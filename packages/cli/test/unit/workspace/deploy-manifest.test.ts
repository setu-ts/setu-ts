import { describe, expect, it } from 'vitest';

import {
  prepareDeployManifest,
  readsMemberSecret,
} from '../../../src/workspace/deploy-manifest.ts';
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
