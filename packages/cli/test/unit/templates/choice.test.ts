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

  // A published template name is public surface (§9.2). The generic refusal
  // lists four names without saying which one took over, so a `nest` user is
  // left guessing that `class-based` is the same template renamed.
  it('names the replacement for a renamed template', () => {
    const choice = choose(['--template', 'nest']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('was renamed to "class-based"');
    expect(choice.message).not.toContain('Unknown template');
  });

  // The registry is a Map, so an inherited property name misses cleanly rather
  // than resolving something off Object.prototype.
  it('refuses an inherited property name', () => {
    const choice = choose(['--template', 'constructor']);
    expect(choice.ok).toBe(false);
  });

  it('treats a template flag without a value as the functional default', () => {
    const choice = choose(['--template']);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.template).toBeUndefined();
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
