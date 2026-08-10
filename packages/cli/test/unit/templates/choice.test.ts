import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseArgs } from '../../../src/args.ts';
import { resolveTemplateChoice } from '../../../src/templates/choice.ts';

/**
 * Resolves a choice from raw argv.
 *
 * @param argv - The arguments after the verb
 * @param runtime - The runtime target the project will use
 * @returns The choice
 */
function choose(argv: readonly string[], runtime: 'deno' | 'node' | 'bun' | 'cloudflare-workers') {
  return resolveTemplateChoice(parseArgs(argv), runtime);
}

describe('resolveTemplateChoice', () => {
  it('accepts no template at all', () => {
    const choice = choose([], 'deno');
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.template).toBeUndefined();
    expect(choice.features).toEqual({ di: false });
  });

  it('resolves a known template', () => {
    const choice = choose(['--template', 'rest'], 'deno');
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.template?.name).toBe('rest');
  });

  it('reads --di as a boolean flag', () => {
    const choice = choose(['--di'], 'deno');
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.features).toEqual({ di: true });
  });

  it('refuses an unknown template, naming every real one', () => {
    const choice = choose(['--template', 'nope'], 'deno');
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('Unknown template "nope"');
    expect(choice.message).toContain('microservice');
  });

  // The registry is a Map, so an inherited property name misses cleanly rather
  // than resolving something off Object.prototype.
  it('refuses an inherited property name', () => {
    const choice = choose(['--template', 'constructor'], 'deno');
    expect(choice.ok).toBe(false);
  });

  // Refused at scaffold time rather than deployed and broken at first use.
  it('refuses a template/runtime pairing the template rejects, naming the reason', () => {
    const choice = choose(['--template', 'microservice'], 'cloudflare-workers');
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('does not support --runtime cloudflare-workers');
    expect(choice.message).toContain('raw sockets');
  });

  it('accepts that same template on a runtime it supports', () => {
    expect(choose(['--template', 'microservice'], 'deno').ok).toBe(true);
  });
});
