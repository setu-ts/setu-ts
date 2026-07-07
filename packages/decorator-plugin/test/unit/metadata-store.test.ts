import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Constructor, MiddlewareFunction } from '@hono-enterprise/common';

import { MetadataStore } from '../../src/metadata/metadata-store.ts';

const noop: MiddlewareFunction = () => {};

describe('MetadataStore', () => {
  let store: MetadataStore;

  beforeEach(() => {
    store = new MetadataStore();
  });

  describe('controller metadata', () => {
    it('stores and retrieves controller metadata', () => {
      class Ctrl {}
      store.mergeController(Ctrl, { path: '/users' });
      expect(store.hasController(Ctrl)).toBe(true);
      expect(store.getController(Ctrl)?.path).toBe('/users');
    });

    it('returns undefined for an unknown controller', () => {
      class Ctrl {}
      expect(store.getController(Ctrl)).toBeUndefined();
      expect(store.hasController(Ctrl)).toBe(false);
    });

    it('last path wins; array fields append on merge', () => {
      class Ctrl {}
      store.mergeController(Ctrl, { path: '/first', guards: [noop] });
      store.mergeController(Ctrl, { path: '/second', guards: [noop], interceptors: [noop] });
      const meta = store.getController(Ctrl);
      expect(meta?.path).toBe('/second');
      expect(meta?.guards).toHaveLength(2);
      expect(meta?.interceptors).toHaveLength(1);
    });

    it('stores version, roles, and permissions', () => {
      class Ctrl {}
      store.mergeController(Ctrl, {
        path: '/x',
        version: 'v1',
        roles: ['admin'],
        permissions: ['read'],
      });
      const meta = store.getController(Ctrl);
      expect(meta?.version).toBe('v1');
      expect(meta?.roles).toEqual(['admin']);
      expect(meta?.permissions).toEqual(['read']);
    });

    it('initializes arrays empty by default', () => {
      class Ctrl {}
      store.mergeController(Ctrl, { path: '/x' });
      const meta = store.getController(Ctrl);
      expect(meta?.middleware).toEqual([]);
      expect(meta?.guards).toEqual([]);
      expect(meta?.filters).toEqual([]);
      expect(meta?.tags).toEqual([]);
    });
  });

  describe('service metadata', () => {
    it('stores and retrieves service metadata', () => {
      class Svc {}
      store.mergeService(Svc, { scope: 'singleton', token: 'svc', inject: ['db'] });
      const meta = store.getService(Svc);
      expect(meta?.scope).toBe('singleton');
      expect(meta?.token).toBe('svc');
      expect(meta?.inject).toEqual(['db']);
      expect(store.hasService(Svc)).toBe(true);
    });

    it('returns undefined for an unknown service', () => {
      class Svc {}
      expect(store.getService(Svc)).toBeUndefined();
      expect(store.hasService(Svc)).toBe(false);
    });

    it('overwrites scalar fields on re-merge', () => {
      class Svc {}
      store.mergeService(Svc, { scope: 'singleton', token: 'a' });
      store.mergeService(Svc, { scope: 'transient' });
      const meta = store.getService(Svc);
      expect(meta?.scope).toBe('transient');
      expect(meta?.token).toBe('a');
    });
  });

  describe('route metadata', () => {
    it('materializes a route from a binding and params', () => {
      class Ctrl {}
      store.addRouteBinding(Ctrl, 'list', 'GET', '/');
      store.storeParam(Ctrl, 'list', { index: 0, type: 'query', name: 'q' });
      store.mutateMethod(Ctrl, 'list', (m) => {
        m.roles = ['admin'];
      });
      const routes = store.getRoutesFor(Ctrl);
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe('GET');
      expect(routes[0].path).toBe('/');
      expect(routes[0].handler).toBe('list');
      expect(routes[0].params).toHaveLength(1);
      expect(routes[0].params[0]).toMatchObject({ index: 0, type: 'query', name: 'q' });
      expect(routes[0].roles).toEqual(['admin']);
    });

    it('produces one route per binding (multiple HTTP verbs)', () => {
      class Ctrl {}
      store.addRouteBinding(Ctrl, 'get', 'GET', '/:id');
      store.addRouteBinding(Ctrl, 'get', 'HEAD', '/:id');
      const routes = store.getRoutesFor(Ctrl);
      expect(routes).toHaveLength(2);
      expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'HEAD']);
      expect(routes.every((r) => r.handler === 'get')).toBe(true);
    });

    it('shares params across bindings of the same method', () => {
      class Ctrl {}
      store.storeParam(Ctrl, 'get', { index: 0, type: 'param', name: 'id' });
      store.addRouteBinding(Ctrl, 'get', 'GET', '/:id');
      store.addRouteBinding(Ctrl, 'get', 'HEAD', '/:id');
      const routes = store.getRoutesFor(Ctrl);
      expect(routes[0].params).toHaveLength(1);
      expect(routes[1].params).toHaveLength(1);
    });

    it('exposes routes via the IMetadataStore getter', () => {
      class Ctrl {}
      store.addRouteBinding(Ctrl, 'list', 'GET', '/');
      const map = store.routes;
      expect(map.has(Ctrl)).toBe(true);
      expect(map.get(Ctrl)).toHaveLength(1);
    });

    it('returns empty for an unknown controller', () => {
      class Ctrl {}
      expect(store.getRoutesFor(Ctrl)).toEqual([]);
      expect(store.getMethods(Ctrl).size).toBe(0);
    });

    it('methods with no bindings produce no routes', () => {
      class Ctrl {}
      store.storeParam(Ctrl, 'orphan', { index: 0, type: 'body' });
      expect(store.getRoutesFor(Ctrl)).toEqual([]);
    });
  });

  describe('custom decorators', () => {
    it('records and returns custom decorator records', () => {
      class Ctrl {}
      store.addCustomDecorator({ name: 'cache:cacheable', metadata: { ttl: 60 }, target: Ctrl });
      store.addCustomDecorator({
        name: 'cache:cacheable',
        metadata: { ttl: 30 },
        target: Ctrl,
        propertyKey: 'list',
      });
      const records = store.getCustomDecorators();
      expect(records).toHaveLength(2);
      expect(records[0].metadata).toEqual({ ttl: 60 });
      expect(records[1].propertyKey).toBe('list');
    });
  });

  describe('clear', () => {
    it('empties all maps', () => {
      class Ctrl {}
      class Svc {}
      store.mergeController(Ctrl, { path: '/x' });
      store.mergeService(Svc, { token: 's' });
      store.addRouteBinding(Ctrl, 'list', 'GET', '/');
      store.addCustomDecorator({ name: 'n', metadata: {}, target: Ctrl });
      store.clear();
      expect(store.hasController(Ctrl)).toBe(false);
      expect(store.hasService(Svc)).toBe(false);
      expect(store.getRoutesFor(Ctrl)).toEqual([]);
      expect(store.getCustomDecorators()).toEqual([]);
    });
  });

  it('satisfies the IMetadataStore contract (controllers/services/routes maps)', () => {
    class Ctrl {}
    store.mergeController(Ctrl, { path: '/x' });
    expect(store.controllers.get(Ctrl)).toBeDefined();
    expect(store.services.get(Ctrl)).toBeUndefined();
    // A controller with no routes is absent from the derived routes map.
    expect(store.routes.get(Ctrl)).toBeUndefined();
    void (null as unknown as Constructor);
  });
});
