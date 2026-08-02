/**
 * Tests for media-type.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CONTENT_TYPE_GRAPHQL,
  CONTENT_TYPE_JSON,
  negotiateMediaType,
} from '../../src/http/media-type.ts';

describe('media-type', () => {
  it('returns json for null accept', () => {
    expect(negotiateMediaType(null)).toBe('json');
  });

  it('returns json for empty accept', () => {
    expect(negotiateMediaType('')).toBe('json');
  });

  it('returns json for application/json', () => {
    expect(negotiateMediaType('application/json')).toBe('json');
  });

  it('returns graphql-response for application/graphql-response+json', () => {
    expect(negotiateMediaType('application/graphql-response+json')).toBe('graphql-response');
  });

  it('returns graphql-response when graphql-response is in multi-value accept', () => {
    expect(negotiateMediaType('text/html, application/graphql-response+json, */*')).toBe(
      'graphql-response',
    );
  });

  it('returns json for */*', () => {
    expect(negotiateMediaType('*/*')).toBe('json');
  });

  it('returns json for text/html', () => {
    expect(negotiateMediaType('text/html')).toBe('json');
  });

  it('is case-insensitive', () => {
    expect(negotiateMediaType('APPLICATION/GRAPHQL-RESPONSE+JSON')).toBe('graphql-response');
  });

  it('exports correct content types', () => {
    expect(CONTENT_TYPE_JSON).toBe('application/json; charset=utf-8');
    expect(CONTENT_TYPE_GRAPHQL).toBe('application/graphql-response+json; charset=utf-8');
  });
});
