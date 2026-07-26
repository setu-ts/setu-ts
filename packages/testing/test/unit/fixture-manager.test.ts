import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FixtureManager } from '../../src/fixtures/fixture-manager.ts';
import { createMockPlugin } from '../../src/mock-plugin.ts';

describe('FixtureManager', () => {
  it('mock produces a plugin registered under the right token', () => {
    const fixtures = new FixtureManager();
    const svc = { query: () => [] };
    fixtures.mock('database', svc);
    const plugins = fixtures.plugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('database');
    expect(plugins[0].provides).toEqual(['database']);
  });

  it('mock with custom provides registers under the overridden token', () => {
    const fixtures = new FixtureManager();
    fixtures.mock('db-mock', {}, { provides: 'database' });
    const plugins = fixtures.plugins();
    expect(plugins[0].provides).toEqual(['database']);
  });

  it('plugin stores real plugins', () => {
    const fixtures = new FixtureManager();
    const realPlugin = createMockPlugin({ name: 'real', service: {} });
    fixtures.plugin(realPlugin);
    const plugins = fixtures.plugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toBe(realPlugin);
  });

  it('plugins() returns true insertion order (mocks and reals interleaved)', () => {
    const fixtures = new FixtureManager();
    fixtures.mock('first', {});
    const realPlugin = createMockPlugin({ name: 'second', service: {} });
    fixtures.plugin(realPlugin);
    fixtures.mock('third', {});

    const plugins = fixtures.plugins();
    expect(plugins).toHaveLength(3);
    // True insertion order: first(mock), second(real), third(mock)
    expect(plugins[0].name).toBe('first');
    expect(plugins[1].name).toBe('second');
    expect(plugins[2].name).toBe('third');
  });

  it('reset clears the store so plugins() returns []', () => {
    const fixtures = new FixtureManager();
    fixtures.mock('db', {});
    fixtures.plugin(createMockPlugin({ name: 'real', service: {} }));
    expect(fixtures.plugins()).toHaveLength(2);
    fixtures.reset();
    expect(fixtures.plugins()).toHaveLength(0);
  });

  it('chaining mock calls works', () => {
    const fixtures = new FixtureManager();
    fixtures
      .mock('a', {})
      .mock('b', {})
      .plugin(createMockPlugin({ name: 'c', service: {} }));
    expect(fixtures.plugins()).toHaveLength(3);
  });
});
