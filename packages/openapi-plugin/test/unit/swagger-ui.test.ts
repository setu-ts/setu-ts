/**
 * Tests for Swagger UI HTML generator.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { swaggerUiHtml } from '../../src/ui/swagger-ui.ts';

describe('swaggerUiHtml', () => {
  it('should generate HTML with spec URL', () => {
    const html = swaggerUiHtml('/openapi.json');

    expect(html).toContain('/openapi.json');
  });

  it('should include Swagger UI CDN script tags', () => {
    const html = swaggerUiHtml('/openapi.json');

    expect(html).toContain('unpkg.com/swagger-ui-dist');
    expect(html).toContain('swagger-ui-bundle.js');
    expect(html).toContain('swagger-ui-standalone-preset.js');
  });

  it('should include Swagger UI CDN CSS link', () => {
    const html = swaggerUiHtml('/openapi.json');

    expect(html).toContain('swagger-ui.css');
  });

  it('should use custom spec URL when provided in options', () => {
    const html = swaggerUiHtml({
      specUrl: '/api/docs.json',
    });

    expect(html).toContain('/api/docs.json');
  });

  it('should use custom title when provided', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: 'My API Docs',
    });

    expect(html).toContain('<title>My API Docs</title>');
  });

  it('should use default title when not provided', () => {
    const html = swaggerUiHtml('/openapi.json');

    expect(html).toContain('<title>API Documentation</title>');
  });

  it('should produce different HTML for different spec URLs', () => {
    const html1 = swaggerUiHtml('/openapi.json');
    const html2 = swaggerUiHtml('/api/spec.json');

    expect(html1).not.toBe(html2);
    expect(html1).toContain('/openapi.json');
    expect(html2).toContain('/api/spec.json');
  });

  it('should include Swagger UI initialization script', () => {
    const html = swaggerUiHtml('/openapi.json');

    expect(html).toContain('SwaggerUIBundle');
    expect(html).toContain('dom_id: "#swagger-ui"');
    expect(html).toContain('deepLinking: true');
  });

  it('should include basic styling', () => {
    const html = swaggerUiHtml('/openapi.json');

    expect(html).toContain('#swagger-ui');
    expect(html).toContain('max-width: 1460px');
  });

  it('should escape ampersand characters', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: 'Test & Demo',
    });

    expect(html).toContain('Test ' + String.fromCharCode(38) + 'amp; Demo');
  });

  it('should escape less-than characters', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: 'Test <Demo>',
    });

    expect(html).toContain(
      'Test ' + String.fromCharCode(38) + 'lt;Demo' + String.fromCharCode(38) + 'gt;',
    );
  });

  it('should escape greater-than characters', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: 'Test >Demo<',
    });

    expect(html).toContain(
      'Test ' + String.fromCharCode(38) + 'gt;Demo' + String.fromCharCode(38) + 'lt;',
    );
  });

  it('should escape double quote characters', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: 'Test "Demo"',
    });

    expect(html).toContain(
      'Test ' + String.fromCharCode(38) + 'quot;Demo' + String.fromCharCode(38) + 'quot;',
    );
  });

  it('should escape single quote characters', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: "Test 'Demo'",
    });

    expect(html).toContain(
      'Test ' + String.fromCharCode(38) + 'apos;Demo' + String.fromCharCode(38) + 'apos;',
    );
  });

  it('should escape multiple special characters', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: '<script>alert("XSS")</script>',
    });

    expect(html).toContain(
      String.fromCharCode(38) + 'lt;script' + String.fromCharCode(38) + 'gt;alert(' +
        String.fromCharCode(38) + 'quot;XSS' + String.fromCharCode(38) + 'quot;)' +
        String.fromCharCode(38) + 'lt;/script' + String.fromCharCode(38) + 'gt;',
    );
  });

  it('should escape ampersand in spec URL', () => {
    const html = swaggerUiHtml({
      specUrl: '/api/spec.json?foo=1&bar=2',
      title: 'Test',
    });

    expect(html).toContain('/api/spec.json?foo=1' + String.fromCharCode(38) + 'amp;bar=2');
  });

  it('should prevent XSS via malicious title input', () => {
    const maliciousTitle = '<script>alert("XSS")</script>';
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: maliciousTitle,
    });

    // The malicious script should be escaped, not executed
    expect(html).not.toContain('<script>alert("XSS")</script>');
    expect(html).toContain(String.fromCharCode(38) + 'lt;script' + String.fromCharCode(38) + 'gt;');
  });

  // N1 regression tests: $-patterns in replacement strings must not be interpreted
  it('should render $-patterns in title verbatim (not as .replace() backreferences)', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: 'Pricing: $1 plan & $2 plan',
    });

    // The escaped title preserves $1/$2 literally, & becomes &amp;
    expect(html).toContain('Pricing: $1 plan &amp; $2 plan');
    expect(html).toContain('<title>Pricing: $1 plan &amp; $2 plan</title>');
  });

  it('should render $& in title verbatim (not as .replace() whole-match reference)', () => {
    const html = swaggerUiHtml({
      specUrl: '/openapi.json',
      title: 'Price: $&',
    });

    // $& is preserved literally, & becomes &amp;
    expect(html).toContain('Price: $&amp;');
    expect(html).toContain('<title>Price: $&amp;</title>');
  });

  it('should render $-patterns in specUrl verbatim', () => {
    const html = swaggerUiHtml({
      specUrl: '/api/v1/$1/$2/spec.json',
      title: 'Test',
    });

    expect(html).toContain('/api/v1/$1/$2/spec.json');
  });

  it('should render $& (whole-match backreference) in specUrl without injection', () => {
    const html = swaggerUiHtml({
      specUrl: '/api/v1/$&/spec.json',
      title: 'Test',
    });

    // $& is preserved literally; & becomes &amp; via htmlEscape
    expect(html).toContain('/api/v1/$&amp;/spec.json');
    // The old string-replacement bug would corrupt $& into the matched substring (__SPEC_URL__)
    // Function replacement preserves it literally
    expect(html).not.toContain('__SPEC_URL__');
  });

  it('should render $` (pre-match backreference) in specUrl without injection', () => {
    const html = swaggerUiHtml({
      specUrl: '/api/v1/$`/spec.json',
      title: 'Test',
    });

    // $` is preserved literally; ` is not escaped by htmlEscape
    expect(html).toContain('/api/v1/$`/spec.json');
    expect(html).not.toContain('__SPEC_URL__');
  });

  it("should render $' (post-match backreference) in specUrl without injection", () => {
    const html = swaggerUiHtml({
      specUrl: "/api/v1/$'/spec.json",
      title: 'Test',
    });

    // $' is preserved literally; ' is not escaped by htmlEscape
    expect(html).toContain('/api/v1/$&apos;/spec.json');
    expect(html).not.toContain('__SPEC_URL__');
  });
});
