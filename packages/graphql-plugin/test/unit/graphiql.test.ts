/**
 * Tests for graphiql.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { graphiqlHtml } from '../../src/ui/graphiql.ts';

describe('graphiqlHtml', () => {
  it('generates HTML with endpoint', () => {
    const html = graphiqlHtml({ endpoint: '/graphql' });

    expect(html).toContain('<title>GraphiQL</title>');
    expect(html).toContain("url: '/graphql'");
    expect(html).toContain('GraphiQL.createFetcher');
  });

  it('uses custom title', () => {
    const html = graphiqlHtml({ endpoint: '/graphql', title: 'My GraphQL IDE' });

    expect(html).toContain('<title>My GraphQL IDE</title>');
  });

  it('escapes HTML in endpoint', () => {
    const html = graphiqlHtml({ endpoint: "/graphql' onclick='alert(1)'//" });

    expect(html).not.toContain("onclick='alert(1)'");
    expect(html).toContain('&#039;');
  });

  it('escapes HTML in title', () => {
    const html = graphiqlHtml({ endpoint: '/graphql', title: '<script>alert(1)</script>' });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('<script>');
  });

  it('includes React and GraphiQL CDN links', () => {
    const html = graphiqlHtml({ endpoint: '/graphql' });

    expect(html).toContain('unpkg.com/react');
    expect(html).toContain('unpkg.com/react-dom');
    expect(html).toContain('unpkg.com/graphiql');
  });
});
