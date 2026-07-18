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
    expect(html).toContain("dom_id: '#swagger-ui'");
    expect(html).toContain('deepLinking: true');
  });

  it('should include basic styling', () => {
    const html = swaggerUiHtml('/openapi.json');

    expect(html).toContain('#swagger-ui');
    expect(html).toContain('max-width: 1460px');
  });
});
