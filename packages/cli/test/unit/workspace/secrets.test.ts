import { describe, expect, it } from 'vitest';

import {
  base64Utf8,
  declaredSecretNames,
  envFromBlock,
  memberSecretName,
  missingSecretNames,
  renderMemberSecret,
  secretValuesPath,
} from '../../../src/workspace/secrets.ts';

describe('member secrets', () => {
  it('names the values file and the Secret', () => {
    expect(secretValuesPath('portal')).toBe('k8s/secrets/portal/.env');
    expect(memberSecretName('portal')).toBe('portal-env');
  });

  it('declares the example keys minus the generated environment, in file order', () => {
    const example =
      '# what to set\nTRUSTED_PROXIES=\nexport SESSION_SECRET=\nREDIS_URL=redis://x\n';
    expect(declaredSecretNames(example, new Set(['REDIS_URL']))).toEqual([
      'TRUSTED_PROXIES',
      'SESSION_SECRET',
    ]);
    expect(() => declaredSecretNames('BROKEN', new Set())).toThrow(/line 1/);
  });

  it('counts an empty value as present', () => {
    expect(missingSecretNames(['A', 'B', 'C'], { B: '' })).toEqual(['A', 'C']);
  });

  it('encodes UTF-8 bytes, not UTF-16 code units', () => {
    expect(base64Utf8('é')).toBe('w6k=');
    expect(base64Utf8('')).toBe('');
    // Round trip through the platform decoder.
    const value = 'a:b # "q" \'s\'\nline2 ✓';
    const bytes = Uint8Array.from(atob(base64Utf8(value)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(value);
  });

  it('renders base64 data only, so no value needs quoting or appears in the clear', () => {
    const value = 'a:b # "q" \'s\'\nline2';
    const yaml = renderMemberSecret('portal', 'shop', 'acme', { SESSION_SECRET: value, EMPTY: '' });
    expect(yaml).toBe(`apiVersion: v1
kind: Secret
metadata:
  name: portal-env
  namespace: shop
  labels:
    app.kubernetes.io/name: portal
    app.kubernetes.io/part-of: acme
    app.kubernetes.io/managed-by: setu
type: Opaque
data:
  SESSION_SECRET: ${base64Utf8(value)}
  EMPTY: ''
`);
    expect(yaml).not.toContain('stringData');
    expect(yaml).not.toContain('line2');
    expect(renderMemberSecret('orders', 'shop', 'acme', {})).toContain('data: {}\n');
  });

  it('renders the envFrom block a Deployment reads it through', () => {
    expect(envFromBlock('portal')).toBe(
      '          envFrom:\n            - secretRef:\n                name: portal-env\n                optional: true',
    );
  });
});
