import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseArgs } from '../../../src/args.ts';
import { resolveTemplateChoice } from '../../../src/templates/choice.ts';
import { listTemplates } from '../../../src/templates/registry.ts';

/**
 * Resolves a choice from raw argv.
 *
 * @param argv - The arguments after the verb
 * @returns The choice
 */
function choose(argv: readonly string[]) {
  return resolveTemplateChoice(parseArgs(argv));
}

describe('resolveTemplateChoice', () => {
  it('accepts no template at all', () => {
    const choice = choose([]);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.template).toBeUndefined();
  });

  it('resolves a known template', () => {
    const choice = choose(['--template', 'rest']);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.template?.name).toBe('rest');
  });

  it('refuses the retired independent DI flag', () => {
    const choice = choose(['--di']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('--template class-based');
  });

  it('refuses an unknown template, naming every real one', () => {
    const choice = choose(['--template', 'nope']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('Unknown template "nope"');
    expect(choice.message).toContain('microservice');
  });

  // The registry is a Map, so an inherited property name misses cleanly rather
  // than resolving something off Object.prototype.
  it('refuses an inherited property name', () => {
    const choice = choose(['--template', 'constructor']);
    expect(choice.ok).toBe(false);
  });

  // Selection no longer depends on the runtime target at all: a template that
  // renders differently per runtime declares a `RuntimeSwap` instead, applied
  // in `resolveHost`. Every template in the registry is therefore selectable.
  it('accepts every template in the registry', () => {
    for (const template of listTemplates()) {
      expect(choose(['--template', template.name]).ok).toBe(true);
    }
  });
});
