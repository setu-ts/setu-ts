import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTerminalPrompter, type PromptChoice } from '../../src/prompt.ts';

// Generic fallback contract only: Enter takes the FIRST choice. WHICH value
// that first choice is for the template question is pinned where the question
// is built — new-interactive.test.ts and new-command.test.ts pin Enter to the
// same default `--yes` takes (no --template flag, MINIMAL_HOST).
const CHOICES: readonly PromptChoice[] = [
  { value: 'rest', label: 'REST set' },
  { value: 'microservice', label: 'microservice set' },
];

describe('createTerminalPrompter', () => {
  it('never reaches the prompt function on a non-terminal and resolves undefined', async () => {
    let asked = false;
    const prompter = createTerminalPrompter(
      () => false,
      () => {
        asked = true;
        return 'rest';
      },
      () => {},
    );
    expect(await prompter.select('Template?', CHOICES)).toBeUndefined();
    expect(asked).toBe(false);
  });

  it('treats a null answer as "cannot ask" and resolves undefined', async () => {
    const prompter = createTerminalPrompter(() => true, () => null, () => {});
    expect(await prompter.select('Template?', CHOICES)).toBeUndefined();
  });

  it('resolves the fallback for a bare Enter', async () => {
    const prompter = createTerminalPrompter(() => true, () => '', () => {});
    expect(await prompter.select('Template?', CHOICES)).toBe('rest');
  });

  it('resolves an exact answer to itself', async () => {
    const prompter = createTerminalPrompter(() => true, () => 'microservice', () => {});
    expect(await prompter.select('Template?', CHOICES)).toBe('microservice');
  });

  it('re-asks after an unrecognized answer and resolves the next valid one', async () => {
    const answers = ['aaa', 'microservice'];
    const prompter = createTerminalPrompter(
      () => true,
      () => answers.shift() ?? null,
      () => {},
    );
    expect(await prompter.select('Template?', CHOICES)).toBe('microservice');
  });

  it('stops asking when EOF follows an unrecognized answer', async () => {
    // The retry loop's bound: mid-session EOF looks exactly like a
    // non-terminal, and both mean stop rather than loop forever.
    const answers = ['aaa', null];
    const prompter = createTerminalPrompter(
      () => true,
      () => answers.shift() ?? null,
      () => {},
    );
    expect(await prompter.select('Template?', CHOICES)).toBeUndefined();
  });

  it('prints the choice list through log and asks the question through the prompt', async () => {
    const printed: string[] = [];
    let question = '';
    const prompter = createTerminalPrompter(
      () => true,
      (message) => {
        question = message;
        return '';
      },
      (message) => printed.push(message),
    );
    await prompter.select('Template?', CHOICES);
    expect(printed.join('\n')).toContain('rest — REST set');
    expect(printed.join('\n')).toContain('microservice — microservice set');
    // The default is rendered INSIDE the question text; the second argument of
    // Deno's prompt() pre-fills an editable buffer and is deliberately unused.
    expect(question).toContain('Template? [rest]');
  });

  // M99e audit F4: the prompter prints through its own sink, which `runCli`
  // does not wrap, and a rejected answer is echoed back. A pasted answer
  // carrying BS/BEL/ESC/U+2028 or a line feed must come back escaped, on one line.
  it('echoes a rejected answer with its control characters escaped', async () => {
    const answers = [
      ['x', String.fromCharCode(27), '[31m', String.fromCharCode(7), String.fromCharCode(8), 'y']
        .join(''),
      `a${String.fromCharCode(0x2028)}INJECTED: done`,
      'a\nINJECTED: scaffold complete',
      'rest',
    ];
    const printed: string[] = [];
    const prompter = createTerminalPrompter(
      () => true,
      () => answers.shift() ?? null,
      (message) => printed.push(message),
    );
    expect(await prompter.select('Template?', CHOICES)).toBe('rest');
    const retries = printed.filter((line) => line.includes('is not one of'));
    expect(retries).toEqual([
      '"x\\u001b[31m\\u0007\\u0008y" is not one of: rest, microservice.',
      '"a\\u2028INJECTED: done" is not one of: rest, microservice.',
      '"a\\u000aINJECTED: scaffold complete" is not one of: rest, microservice.',
    ]);
    for (const code of [7, 8, 27, 0x2028]) {
      expect(printed.join('\n').includes(String.fromCharCode(code))).toBe(false);
    }
    // A pasted line feed survives prompt() and the sink escape keeps it, so
    // only the per-site escape stops it forging a line of its own.
    expect(printed.flatMap((line) => line.split('\n')).filter((l) => l.startsWith('INJECTED')))
      .toEqual([]);
  });

  // The menu is caller-supplied text printed through the same sink: a label
  // carrying a control character is escaped by the sink escape, not per site.
  it('escapes a control character in a choice label', async () => {
    const printed: string[] = [];
    const esc = String.fromCharCode(27);
    const prompter = createTerminalPrompter(
      () => true,
      () => '',
      (message) => printed.push(message),
    );
    await prompter.select('Template?', [{ value: 'rest', label: `${esc}[2Kfake` }]);
    expect(printed.join('\n').includes(esc)).toBe(false);
    expect(printed.join('\n')).toContain('\\u001b[2Kfake');
  });
});
