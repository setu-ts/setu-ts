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
    expect(choice.message).toContain('--style class-based');
  });

  it('resolves --style class-based to the template precomputed variant', () => {
    const choice = choose(['--template', 'rest', '--style', 'class-based']);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.template?.name).toBe('rest');
    // The host is the classBased variant, not the template itself.
    expect(choice.host).toBe(choice.template?.classBased);
  });

  it('resolves --style functional to the template itself', () => {
    const choice = choose(['--template', 'rest', '--style', 'functional']);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.host).toBe(choice.template);
  });

  it('refuses a style with no template', () => {
    const choice = choose(['--style', 'class-based']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('--style applies to a styleable template');
  });

  // Audit F1: an unknown value is quoted back, so a CR/LF or ESC in it would
  // forge a line (or a fake success) in the rendered refusal.
  for (
    const argv of [
      ['--template', 'rest', '--style', 'oop\r\nINJECTED: scaffold complete'],
      ['--template', 'nope\r\nINJECTED: scaffold complete'],
      ['--template', 'rest', '--style', '\u001b[2K\u001b[1GCreated x'],
    ]
  ) {
    it(`escapes control characters in ${JSON.stringify(argv.at(-1))}`, () => {
      const choice = choose(argv);
      expect(choice.ok).toBe(false);
      if (choice.ok) return;
      expect(/[\r\n]/.test(choice.message) || choice.message.includes(String.fromCharCode(27)))
        .toBe(false);
      expect(choice.message).toMatch(/\\u00(0d|1b)/);
    });
  }

  it('refuses an unknown style', () => {
    const choice = choose(['--template', 'rest', '--style', 'imperative']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('Unknown style "imperative"');
  });

  it('refuses class-based on a template without a variant', () => {
    const choice = choose(['--template', 'full-stack', '--style', 'class-based']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('cannot apply to --template full-stack');
  });

  // The plan (§3.3) and the CHANGELOG both say `--style` is refused on
  // `full-stack`. `functional` there used to be accepted silently — a flag with
  // no effect, which the M72 rule refuses wherever it would be a no-op.
  it('refuses functional on a template without a variant', () => {
    const choice = choose(['--template', 'full-stack', '--style', 'functional']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('cannot apply to --template full-stack');
  });

  it('refuses functional on the class-based alias', () => {
    const choice = choose(['--template', 'class-based', '--style', 'functional']);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.message).toContain('use --template rest');
  });

  it('carries the alias notice for the class-based alias', () => {
    const choice = choose(['--template', 'class-based']);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.notice).toBe(
      '--template class-based is an alias of --template rest --style class-based.',
    );
    // The alias resolves to itself.
    expect(choice.host).toBe(choice.template);
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
