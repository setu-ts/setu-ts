import { describe, expect, it } from 'vitest';
import { parseArgs, stringFlag, stringFlags } from '../../src/args.ts';

describe('parseArgs', () => {
  it('returns empty positionals and flags for empty argv', () => {
    const args = parseArgs([]);
    expect(args.positionals).toEqual([]);
    expect(args.flags).toEqual({});
  });

  it('collects positionals in order', () => {
    expect(parseArgs(['generate', 'service', 'user']).positionals).toEqual([
      'generate',
      'service',
      'user',
    ]);
  });

  it('treats long and short flags without values as boolean', () => {
    const args = parseArgs(['--dry-run', '-h']);
    expect(args.flags['dry-run']).toBe(true);
    expect(args.flags['h']).toBe(true);
  });

  it('parses --key=value', () => {
    expect(parseArgs(['--dir=/tmp/app']).flags['dir']).toBe('/tmp/app');
  });

  it('parses -k=value', () => {
    expect(parseArgs(['-d=/tmp/app']).flags['d']).toBe('/tmp/app');
  });

  it('keeps everything after the first = in a --key=value pair', () => {
    expect(parseArgs(['--dir=/tmp/a=b']).flags['dir']).toBe('/tmp/a=b');
  });

  it('treats --key= with an empty value as boolean true', () => {
    expect(parseArgs(['--dir=']).flags['dir']).toBe(true);
  });

  it('consumes the next token for a declared value flag', () => {
    const args = parseArgs(['new', 'app', '--dir', '/tmp/app', '--runtime', 'bun']);
    expect(args.flags['dir']).toBe('/tmp/app');
    expect(args.flags['runtime']).toBe('bun');
    expect(args.positionals).toEqual(['new', 'app']);
  });

  it('does not consume the next token for an undeclared flag', () => {
    const args = parseArgs(['--dry-run', 'service']);
    expect(args.flags['dry-run']).toBe(true);
    expect(args.positionals).toEqual(['service']);
  });

  it('leaves a value flag boolean when the next token is another flag', () => {
    const args = parseArgs(['--dir', '--dry-run']);
    expect(args.flags['dir']).toBe(true);
    expect(args.flags['dry-run']).toBe(true);
  });

  it('leaves a value flag boolean when it is the last token', () => {
    expect(parseArgs(['--dir']).flags['dir']).toBe(true);
  });

  it('leaves a value flag boolean when followed by the terminator', () => {
    const args = parseArgs(['--dir', '--', 'x']);
    expect(args.flags['dir']).toBe(true);
    expect(args.positionals).toEqual(['x']);
  });

  it('accepts flags before and after positionals', () => {
    const args = parseArgs(['--dry-run', 'g', 'service', 'user', '--dir', '/tmp']);
    expect(args.positionals).toEqual(['g', 'service', 'user']);
    expect(args.flags).toEqual({ 'dry-run': true, dir: '/tmp' });
  });

  it('treats everything after -- as positional', () => {
    const args = parseArgs(['g', '--', '--dry-run', '-h']);
    expect(args.positionals).toEqual(['g', '--dry-run', '-h']);
    expect(args.flags).toEqual({});
  });

  it('treats a bare - as a positional', () => {
    expect(parseArgs(['-']).positionals).toEqual(['-']);
  });

  it('lets a later occurrence of a repeated flag win', () => {
    expect(parseArgs(['--dir', '/a', '--dir', '/b']).flags['dir']).toBe('/b');
  });

  it('keeps every repeated dependency flag in order', () => {
    expect(
      parseArgs(['--depends-on', 'orders', '--depends-on=billing']).flags['depends-on'],
    ).toEqual(['orders', 'billing']);
  });

  it('keeps every repeated --build-arg in order (M122)', () => {
    expect(parseArgs(['--build-arg', 'A=1', '--build-arg=B=2']).flags['build-arg']).toEqual([
      'A=1',
      'B=2',
    ]);
  });

  it('honours a caller-supplied value-flag set', () => {
    const args = parseArgs(['--out', 'x'], new Set(['out']));
    expect(args.flags['out']).toBe('x');
    expect(args.positionals).toEqual([]);
  });
});

describe('stringFlag', () => {
  it('returns the value of a string flag', () => {
    expect(stringFlag({ dir: '/tmp' }, 'dir')).toBe('/tmp');
  });

  it('returns undefined for a boolean flag', () => {
    expect(stringFlag({ dir: true }, 'dir')).toBeUndefined();
  });

  it('returns undefined for an absent flag', () => {
    expect(stringFlag({}, 'dir')).toBeUndefined();
  });
});

describe('stringFlags', () => {
  it('normalizes a one-time flag and reads repeated values', () => {
    expect(stringFlags({ dependency: 'orders' }, 'dependency')).toEqual(['orders']);
    expect(stringFlags({ dependency: ['orders', 'billing'] }, 'dependency')).toEqual([
      'orders',
      'billing',
    ]);
  });
});

it('replaces incomplete repeated dependency flags without retaining a boolean in the list', () => {
  expect(
    parseArgs(['--depends-on=a', '--depends-on=b', '--depends-on=c']).flags['depends-on'],
  ).toEqual(['a', 'b', 'c']);
  expect(parseArgs(['--depends-on=a', '--depends-on=b', '--depends-on']).flags['depends-on']).toBe(
    true,
  );
  expect(parseArgs(['--depends-on', '--depends-on=c']).flags['depends-on']).toBe('c');
});
