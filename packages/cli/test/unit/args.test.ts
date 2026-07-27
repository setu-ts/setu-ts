/**
 * Unit tests for the argument parser.
 *
 * @module
 */

import { parseArgs } from '../../src/args.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('parseArgs', () => {
  it('parses simple positionals', () => {
    const result = parseArgs(['new', 'my-app']);
    expect(result.positionals).toEqual(['new', 'my-app']);
    expect(result.flags).toEqual({});
    expect(result.endOfOptions).toBe(false);
  });

  it('parses flags before positionals', () => {
    const result = parseArgs(['--dry-run', 'generate', 'controller', 'user']);
    expect(result.positionals).toEqual(['generate', 'controller', 'user']);
    expect(result.flags['dry-run']).toBe(true);
    expect(result.endOfOptions).toBe(false);
  });

  it('parses flags after positionals', () => {
    const result = parseArgs(['generate', 'service', 'user', '--dir=./src']);
    expect(result.positionals).toEqual(['generate', 'service', 'user']);
    expect(result.flags['dir']).toBe('./src');
    expect(result.endOfOptions).toBe(false);
  });

  it('parses key=value flags', () => {
    const result = parseArgs(['generate', 'controller', 'user', '--key=value']);
    expect(result.positionals).toEqual(['generate', 'controller', 'user']);
    expect(result.flags['key']).toBe('value');
  });

  it('parses boolean flags without values', () => {
    const result = parseArgs(['--verbose', 'generate', 'service']);
    expect(result.positionals).toEqual(['generate', 'service']);
    expect(result.flags['verbose']).toBe(true);
  });

  it('handles -- terminator correctly', () => {
    const result = parseArgs(['generate', 'controller', '--', '--flag', 'value']);
    expect(result.positionals).toEqual(['generate', 'controller', '--flag', 'value']);
    expect(result.endOfOptions).toBe(true);
  });

  it('parses short flags', () => {
    const result = parseArgs(['-d', 'generate', 'service']);
    expect(result.positionals).toEqual(['generate', 'service']);
    expect(result.flags['d']).toBe(true);
  });

  it('handles short flag with value', () => {
    const result = parseArgs(['-d=./src', 'generate', 'service']);
    expect(result.positionals).toEqual(['generate', 'service']);
    expect(result.flags['d']).toBe('./src');
  });

  it('parses empty argv', () => {
    const result = parseArgs([]);
    expect(result.positionals).toEqual([]);
    expect(result.flags).toEqual({});
    expect(result.endOfOptions).toBe(false);
  });
});
