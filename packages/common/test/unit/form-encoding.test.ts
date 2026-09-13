/**
 * Tests for the {@linkcode formEncodingOf} classifier — the ONE content-type
 * check both first-party form consumers read (M94b), replacing two private
 * `includes()` copies that disagreed on case folding.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { formEncodingOf } from '../../src/form/form-body.ts';

describe('formEncodingOf', () => {
  it('classifies a multipart content-type', () => {
    expect(formEncodingOf('multipart/form-data; boundary=----WebKitFormBoundary')).toBe(
      'multipart',
    );
  });

  it('classifies a urlencoded content-type', () => {
    expect(formEncodingOf('application/x-www-form-urlencoded')).toBe('urlencoded');
  });

  it('case-folds, where the private checks it replaced disagreed', () => {
    // `upload-middleware.ts` used a raw `includes()` (no folding); the CSRF
    // verifier lower-cased first. One classifier, one answer.
    expect(formEncodingOf('MULTIPART/FORM-DATA; BOUNDARY=fb')).toBe('multipart');
    expect(formEncodingOf('Application/X-WWW-Form-UrlEncoded')).toBe('urlencoded');
  });

  it('tolerates parameters on the urlencoded type', () => {
    expect(formEncodingOf('application/x-www-form-urlencoded; charset=UTF-8')).toBe('urlencoded');
  });

  it('answers undefined for a missing or empty content-type', () => {
    expect(formEncodingOf(null)).toBeUndefined();
    expect(formEncodingOf('')).toBeUndefined();
  });

  it('answers undefined for a non-form type', () => {
    expect(formEncodingOf('application/json')).toBeUndefined();
    expect(formEncodingOf('text/plain')).toBeUndefined();
  });

  it('answers undefined for a multipart type carrying no boundary', () => {
    // The body cannot be parsed as a form, so reporting an encoding would
    // hand the caller a guaranteed throw (§3.4).
    expect(formEncodingOf('multipart/form-data')).toBeUndefined();
  });
});
