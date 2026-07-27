/**
 * Unit tests for the command-handler schematic (gated on cqrs-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateCommandHandler } from '../../../src/schematics/command-handler.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateCommandHandler', () => {
  it('emits a command handler file implementing ICommandHandler', () => {
    const names = deriveNames('create-user');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateCommandHandler(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/cqrs/create-user.command-handler.ts');
    expect(files[0].contents).toContain('implements ICommandHandler');
  });

  it('creates a command class name from input', () => {
    const names = deriveNames('update-profile');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateCommandHandler(names, options);

    expect(files[0].contents).toContain('UpdateProfileCommand');
  });
});
