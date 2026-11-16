/**
 * `setu add cloudflare` on a generated Workers config: the `CloudflarePlugin`
 * call and the rename of the factory's unread `_waitUntil` parameter happen
 * together, or the config is left for the printed guidance.
 */
import { describe, expect, it } from 'vitest';
import { withCloudflareWiring } from '../../../src/commands/add.ts';
import { MINIMAL_HOST } from '../../../src/templates/minimal.ts';
import { getTemplate } from '../../../src/templates/registry.ts';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';

const CALL = 'CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) })';

/** The `setu.config.ts` a Workers project of `template` is scaffolded with. */
function generated(template: string): string {
  const host = resolveHost(
    template === 'minimal' ? MINIMAL_HOST : getTemplate(template)!,
    'cloudflare-workers',
  );
  return projectFiles('edge', 'cloudflare-workers', host).find(
    ({ path }) => path === 'setu.config.ts',
  )!.contents;
}

describe('withCloudflareWiring', () => {
  it('registers the plugin and renames the parameter and its JSDoc tag together', () => {
    for (const template of ['minimal', 'rest']) {
      const source = generated(template);
      expect(source).toContain('_waitUntil?: (promise: Promise<unknown>) => void,');
      expect(source).toContain('@param _waitUntil ');
      const wired = withCloudflareWiring(source)!;
      expect(wired).toContain("import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';");
      expect(wired).toContain(`${CALL},`);
      expect(wired).toContain('  waitUntil?: (promise: Promise<unknown>) => void,');
      expect(wired).toContain('@param waitUntil ');
      expect(wired).not.toContain('_waitUntil');
      // The call sits in the plugin list, before the generated plugins.
      expect(wired.indexOf(CALL)).toBeLessThan(wired.indexOf('...GENERATED_PLUGINS'));
    }
  });

  it('renames only the parameter when the JSDoc carries no tag for it', () => {
    const source = generated('minimal').replace('@param _waitUntil ', '@param sink ');
    const wired = withCloudflareWiring(source)!;
    expect(wired).toContain('  waitUntil?: (promise: Promise<unknown>) => void,');
    expect(wired).toContain('@param sink ');
  });

  it('inserts the call alone when the parameter is already named waitUntil and unread', () => {
    const source = generated('minimal')
      .replace('_waitUntil?:', 'waitUntil?:')
      .replace('@param _waitUntil ', '@param waitUntil ');
    const wired = withCloudflareWiring(source)!;
    expect(wired).toContain(`${CALL},`);
    expect(wired.split('waitUntil?:')).toHaveLength(2);
  });

  it('ignores a member access and a mention in a comment or string', () => {
    const source = generated('minimal').replace(
      'return app;',
      "// _waitUntil is threaded from the entry\n  void 'waitUntil';\n  void ctx.waitUntil;\n  return app;",
    );
    expect(withCloudflareWiring(source)).toContain(`${CALL},`);
  });

  it('leaves the config for guidance when the parameter is absent, read, or shadowed', () => {
    const source = generated('minimal');
    const cases = [
      // Scaffolded before 0.10.0: no second parameter at all.
      source.replace('  _waitUntil?: (promise: Promise<unknown>) => void,\n', ''),
      // Something already reads the underscored parameter.
      source.replace('return app;', 'void _waitUntil;\n  return app;'),
      // Another `waitUntil` binding would collide with the renamed parameter.
      source.replace('return app;', 'const waitUntil = 1;\n  return app;'),
      // Not a parameter declaration.
      source.replace(
        '_waitUntil?: (promise: Promise<unknown>) => void,',
        '_waitUntil = undefined,',
      ),
      // Already registered: a second call is a duplicate plugin name at boot.
      `import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';\n${source.replace(
        '...GENERATED_PLUGINS',
        'CloudflarePlugin({ env }), ...GENERATED_PLUGINS',
      )}`,
      // Before 0.10.0, with an unrelated `waitUntil?:` member elsewhere in the file.
      `type Sink = { waitUntil?: () => void };\n${source.replace(
        '  _waitUntil?: (promise: Promise<unknown>) => void,\n',
        '',
      )}`,
      // Before 0.10.0, with a helper whose own parameter is `_waitUntil`.
      `${source.replace('  _waitUntil?: (promise: Promise<unknown>) => void,\n', '')}\nexport function later(_waitUntil?: () => void): void {}\n`,
      // A factory whose bindings are not named `env`, which the call reads.
      source.replace('  env: Readonly<', '  bindings: Readonly<'),
      // ...even when a later parameter's type mentions `(env`.
      source
        .replace('  env: Readonly<', '  bindings: Readonly<')
        .replace(
          '_waitUntil?: (promise: Promise<unknown>)',
          '_waitUntil?: (env: Promise<unknown>)',
        ),
      // Unclassifiable source.
      `${source}\nconst broken = 'unterminated`,
    ];
    for (const config of cases) expect(withCloudflareWiring(config)).toBeUndefined();
  });

  it('leaves a microservice config alone, which already registers the plugin', () => {
    expect(withCloudflareWiring(generated('microservice'))).toBeUndefined();
  });
});
