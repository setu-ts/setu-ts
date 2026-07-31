/**
 * RPC dispatcher tests — verifies basePath normalization, prefix checking, and dispatch.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildDispatcherMap,
  dispatchRequest,
  normalizeBasePath,
} from '../../src/transports/rpc-dispatcher.ts';

describe('RPCDispatcher', () => {
  describe('normalizeBasePath', () => {
    it('should normalize to /grpc by default', () => {
      expect(normalizeBasePath()).toBe('/grpc');
    });

    it('should add leading slash if missing', () => {
      expect(normalizeBasePath('grpc')).toBe('/grpc');
    });

    it('should remove trailing slash', () => {
      expect(normalizeBasePath('/grpc/')).toBe('/grpc');
    });

    it('should preserve exact path', () => {
      expect(normalizeBasePath('/custom')).toBe('/custom');
    });
  });

  describe('buildDispatcherMap', () => {
    it('should map handlers with basePath + requestPath keys', () => {
      const handlers = [
        {
          requestPath: '/echo',
          handler: (_request: Request) => Promise.resolve(new Response('OK')),
        },
        {
          requestPath: '/status',
          handler: (_request: Request) => Promise.resolve(new Response('OK')),
        },
      ];
      const map = buildDispatcherMap('/grpc', handlers);

      expect(map.size).toBe(2);
      expect(map.has('/grpc/echo')).toBeTruthy();
      expect(map.has('/grpc/status')).toBeTruthy();
      expect(map.get('/grpc/echo')).toBeDefined();
    });
  });

  describe('dispatchRequest', () => {
    it('should return null for paths outside basePath', async () => {
      const map = new Map<string, (request: Request) => Promise<Response>>();
      const request = new Request('http://example.com/other/path');
      const result = await dispatchRequest(request, map, '/grpc');
      expect(result).toBeNull();
    });

    it('should return handler response for exact match within basePath', async () => {
      const map = new Map<string, (request: Request) => Promise<Response>>();
      map.set('/grpc/async', (_request: Request) => Promise.resolve(new Response('Found')));
      const request = new Request('http://example.com/grpc/async');
      const result = await dispatchRequest(request, map, '/grpc');
      expect(result).not.toBeNull();
      expect((result as Response).status).toBe(200);
    });

    it('should return 404 for unknown path within basePath', async () => {
      const map = new Map<string, (request: Request) => Promise<Response>>();
      // No entry for /grpc/unknown
      const request = new Request('http://example.com/grpc/unknown');
      const result = await dispatchRequest(request, map, '/grpc');
      expect(result).not.toBeNull();
      expect((result as Response).status).toBe(404);
    });

    it('should handle basePath with and without trailing slash identically', async () => {
      const map1 = new Map<string, (request: Request) => Promise<Response>>();
      map1.set('/grpc/async', (_request: Request) => Promise.resolve(new Response('OK')));
      const result1 = await dispatchRequest(
        new Request('http://example.com/grpc/async'),
        map1,
        '/grpc',
      );

      const map2 = new Map<string, (request: Request) => Promise<Response>>();
      map2.set('/grpc/async', (_request: Request) => Promise.resolve(new Response('OK')));
      const result2 = await dispatchRequest(
        new Request('http://example.com/grpc/async'),
        map2,
        '/grpc/',
      ); // normalized to /grpc

      expect(result1 !== null).toBeTruthy();
      expect(result2 !== null).toBeTruthy();
    });
  });
});
