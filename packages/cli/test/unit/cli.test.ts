/**
 * Unit tests for the CLI dispatcher.
 *
 * @module
 */

import { type CliDependencies, runCli } from '../../src/cli.ts';
import { EXIT_OK, EXIT_USAGE } from '../../src/constants.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('runCli', () => {
  it('handles --help and prints usage', async () => {
    const logMessages: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => logMessages.push(args.join(' '));

    const deps: CliDependencies = {
      readVersion: () => Promise.resolve('0.1.0'),
      parseArgs: () => ({ positionals: [], flags: { help: true }, endOfOptions: false }),
    };

    const result = await runCli(['--help'], deps);
    expect(result).toBe(EXIT_OK);
    expect(logMessages).toContain('Usage: honoe [command] [options]');

    console.log = originalConsoleLog;
  });

  it('handles --version and prints version', async () => {
    const logMessages: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => logMessages.push(args.join(' '));

    const deps: CliDependencies = {
      readVersion: () => Promise.resolve('0.1.0'),
      parseArgs: () => ({ positionals: [], flags: { version: true }, endOfOptions: false }),
    };

    const result = await runCli(['--version'], deps);
    expect(result).toBe(EXIT_OK);
    expect(logMessages).toContain('honoe 0.1.0');

    console.log = originalConsoleLog;
  });

  it('handles unknown command', async () => {
    const errorMessages: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errorMessages.push(args.join(' '));

    const deps: CliDependencies = {
      readVersion: () => Promise.resolve('0.1.0'),
      parseArgs: () => ({ positionals: ['unknown'], flags: {}, endOfOptions: false }),
    };

    const result = await runCli(['unknown'], deps);
    expect(result).toBe(EXIT_USAGE);
    expect(errorMessages).toContain('Unknown command: unknown');

    console.error = originalConsoleError;
  });

  it('handles new command when --dry-run flag is set', async () => {
    let capturedArgs: readonly string[] | null = null;
    let capturedOptions: unknown = null;

    const mockRunNew = (args: readonly string[], opts: unknown) => {
      capturedArgs = args;
      capturedOptions = opts;
      return 0;
    };

    const deps: CliDependencies = {
      readVersion: () => Promise.resolve('0.1.0'),
      parseArgs: () => ({
        positionals: ['new', 'my-app'],
        flags: { 'dry-run': true, dir: './src', runtime: 'deno' },
        endOfOptions: false,
      }),
      runNewCommand: mockRunNew,
    };

    await runCli(['new', 'my-app'], deps);

    expect(capturedArgs).toEqual(['my-app']);
    expect(capturedOptions).toEqual({
      dryRun: true,
      dir: './src',
      runtime: 'deno',
    });
  });

  it('handles generate command when --dry-run flag is set', async () => {
    let capturedArgs: readonly string[] | null = null;
    let capturedOptions: unknown = null;

    const mockRunGenerate = async (args: readonly string[], opts: unknown) => {
      capturedArgs = args;
      capturedOptions = opts;
      return 0;
    };

    const deps: CliDependencies = {
      readVersion: () => Promise.resolve('0.1.0'),
      parseArgs: () => ({
        positionals: ['generate', 'controller', 'user'],
        flags: { 'dry-run': true, dir: './test' },
        endOfOptions: false,
      }),
      runGenerateCommand: mockRunGenerate,
    };

    await runCli(['generate', 'controller', 'user'], deps);

    expect(capturedArgs).toEqual(['controller', 'user']);
    expect(capturedOptions).toEqual({ dryRun: true, dir: './test' });
  });
});
