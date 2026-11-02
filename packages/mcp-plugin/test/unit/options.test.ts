import { describe, it, expect } from 'vitest';
import { resolveOptions } from '../../src/options.ts';
import type { McpPluginOptions } from '../../src/options.ts';
import { McpPluginConfigurationError } from '../../src/errors.ts';
import { VERSION } from '../../src/version.ts';
import { declaration } from '../fixtures.ts';
describe('MCP options', () => {
  it('resolves defaults and snapshots input', () => {
    const input = { tools: [declaration] };
    const options = resolveOptions(input);
    expect(options).toEqual({
      tools: [declaration],
      path: '/mcp',
      legacy: 'stateless',
      serverInfo: { name: 'setu-mcp', version: VERSION },
      allowedOrigins: [],
      maxResultBytes: 1048576,
    });
    expect(Object.isFrozen(options)).toBe(true);
    expect(options.tools).not.toBe(input.tools);
  });
  it('consumes every explicit setting', () => {
    const options: McpPluginOptions = {
      tools: [declaration],
      path: '/tools',
      legacy: 'reject',
      serverInfo: { name: 'demo', version: '1' },
      instructions: 'Use safely',
      allowedOrigins: ['https://client.test'],
      maxResultBytes: 50,
    };
    expect(resolveOptions(options)).toEqual(options);
  });
  it.each([
    null,
    { tools: null },
    { path: null },
    { serverInfo: null },
    { legacy: null },
    { maxResultBytes: null },
    { allowedOrigins: null },
    { tools: [] },
    { path: 'mcp' },
    { path: '//evil' },
    { path: '/mcp?x' },
    { path: '/bad path' },
    { allowedOrigins: 'bad' },
    { allowedOrigins: ['not a url'] },
    { allowedOrigins: ['https://client.test/'] },
    { allowedOrigins: ['ftp://client.test'] },
    { maxResultBytes: 0 },
    { maxResultBytes: -1 },
    { maxResultBytes: 1.1 },
    { maxResultBytes: Infinity },
    { maxResultBytes: NaN },
    { maxResultBytes: 64 * 1024 * 1024 + 1 },
    { legacy: 'auto' },
    { serverInfo: {} },
    { instructions: 1 },
  ])('refuses malformed options %j', (bad) => {
    const input = bad === null ? null : { tools: [declaration], ...bad };
    expect(() => resolveOptions(input as unknown as McpPluginOptions)).toThrow(
      McpPluginConfigurationError,
    );
  });
});

it('preserves the declared string server identity without imposing an extra name/version grammar', () => {
  expect(
    resolveOptions({ tools: [declaration], serverInfo: { name: '', version: '' } }).serverInfo,
  ).toEqual({ name: '', version: '' });
});

it('accepts maxResultBytes exactly at the 64 MiB cap', () => {
  const cap = 64 * 1024 * 1024;
  expect(resolveOptions({ tools: [declaration], maxResultBytes: cap }).maxResultBytes).toBe(cap);
});
