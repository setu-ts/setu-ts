/**
 * Tests for http/json-content-type.ts — the one request-body media-type rule
 * both GraphQL POST routes share.
 */

import { describe, expect, it } from 'vitest';
import { isJsonContentType } from '../../src/http/json-content-type.ts';

/** Headers whose media type is `application/json`, parameters ignored. */
const ACCEPTED: readonly string[] = [
  'application/json',
  'Application/JSON',
  ' application/json ; charset=utf-8',
  'application/json;charset=latin1',
];

/**
 * Everything else. The CORS-safelisted types with an `application/json`
 * parameter are the cross-site bypass a substring test let through.
 */
const REFUSED: ReadonlyArray<string | null> = [
  null,
  '',
  'text/plain',
  'text/plain; x=application/json',
  'application/x-www-form-urlencoded; a=application/json',
  'multipart/form-data; boundary=x; a=application/json',
  'application/json-patch+json',
  'application/graphql-response+json',
  'application/jsonx',
  'application/json, text/plain',
];

describe('isJsonContentType', () => {
  for (const header of ACCEPTED) {
    it(`accepts ${JSON.stringify(header)}`, () => {
      expect(isJsonContentType(header)).toBe(true);
    });
  }

  for (const header of REFUSED) {
    it(`refuses ${JSON.stringify(header)}`, () => {
      expect(isJsonContentType(header)).toBe(false);
    });
  }
});
