/** Tests for the telemetry URL egress sanitizer. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMaskRedactor, createRedactionService } from '@setu-ts/common';
import { sanitizeUrl } from '../../src/attributes/sanitize-url.ts';

describe('sanitizeUrl', () => {
  it('omits query strings and fragments by default', () => {
    expect(sanitizeUrl('https://example.test/search?email=a@b.test#details', 'omit', undefined))
      .toBe(
        'https://example.test/search',
      );
  });

  it('omits URL credentials before telemetry export', () => {
    expect(sanitizeUrl(
      'https://operator:secret@example.test/search?email=a@b.test#details',
      'omit',
      undefined,
    )).toBe('https://example.test/search');
  });

  it('redacts classified query values and retains unclassified values', () => {
    const service = createRedactionService({
      fields: { 'query.card': 'pci' },
      redactors: { pci: createMaskRedactor() },
    });

    expect(sanitizeUrl('https://example.test/search?card=12345678&page=2', 'redact', service)).toBe(
      'https://example.test/search?card=****5678&page=2',
    );
  });

  it('preserves repeated query parameters while redacting each occurrence', () => {
    const service = createRedactionService({ fields: { 'query.token': 'secret' } });

    expect(sanitizeUrl(
      'https://example.test/search?tag=first&tag=second&token=one&token=two',
      'redact',
      service,
    )).toBe(
      'https://example.test/search?tag=first&tag=second&token=%5BRedacted%5D&token=%5BRedacted%5D',
    );
  });

  it('fails closed and degrades malformed URLs without throwing', () => {
    expect(sanitizeUrl('https://example.test/search?email=a@b.test', 'redact', undefined)).toBe(
      'https://example.test/search',
    );
    expect(sanitizeUrl('/search?email=a#x', 'omit', undefined)).toBe('/search');
  });
});
