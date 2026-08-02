/**
 * Tests for request-parser.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseGetQuery, parsePostBody } from '../../src/http/request-parser.ts';

describe('request-parser', () => {
  describe('parsePostBody', () => {
    it('parses valid POST body', () => {
      const body = {
        query: 'query { hello }',
        operationName: 'MyQuery',
        variables: { id: '123' },
      };

      const params = parsePostBody(body);

      expect(params.query).toBe('query { hello }');
      expect(params.operationName).toBe('MyQuery');
      expect(params.variables).toEqual({ id: '123' });
    });

    it('handles missing operationName', () => {
      const body = { query: 'query { hello }' };
      const params = parsePostBody(body);

      expect(params.operationName).toBeUndefined();
    });

    it('throws on non-object body', () => {
      expect(() => parsePostBody(null as unknown)).toThrow('BAD_REQUEST');
      expect(() => parsePostBody([] as unknown)).toThrow('BAD_REQUEST');
      expect(() => parsePostBody('string' as unknown)).toThrow('BAD_REQUEST');
    });

    it('throws on missing query', () => {
      expect(() => parsePostBody({} as unknown)).toThrow('BAD_REQUEST');
    });

    it('throws on non-string query', () => {
      expect(() => parsePostBody({ query: 123 } as unknown)).toThrow('BAD_REQUEST');
    });

    it('throws on non-object variables', () => {
      expect(() => parsePostBody({ query: 'q', variables: 'invalid' } as unknown)).toThrow(
        'INVALID_VARIABLES',
      );
    });

    it('accepts extensions (ignored in M51)', () => {
      const body = {
        query: 'query { hello }',
        extensions: { persistedQuery: { sha256Hash: 'abc' } },
      };
      const params = parsePostBody(body);
      expect(params.query).toBe('query { hello }');
    });
  });

  describe('parseGetQuery', () => {
    it('parses valid GET query', () => {
      const query = { query: 'query { hello }' };
      const params = parseGetQuery(query);

      expect(params.query).toBe('query { hello }');
    });

    it('handles operationName', () => {
      const query = { query: 'query { hello }', operationName: 'MyQuery' };
      const params = parseGetQuery(query);

      expect(params.operationName).toBe('MyQuery');
    });

    it('parses variables from JSON string', () => {
      const query = { query: 'query { hello }', variables: JSON.stringify({ id: '123' }) };
      const params = parseGetQuery(query);

      expect(params.variables).toEqual({ id: '123' });
    });

    it('throws on missing query', () => {
      expect(() => parseGetQuery({} as Record<string, string | string[]>)).toThrow('BAD_REQUEST');
    });

    it('throws on invalid variables JSON', () => {
      expect(() =>
        parseGetQuery(
          { query: 'q', variables: 'invalid json' } as Record<string, string | string[]>,
        )
      ).toThrow('INVALID_VARIABLES');
    });

    it('throws on non-object variables JSON', () => {
      expect(() =>
        parseGetQuery({ query: 'q', variables: '[]' } as Record<string, string | string[]>)
      ).toThrow('INVALID_VARIABLES');
    });
  });
});
