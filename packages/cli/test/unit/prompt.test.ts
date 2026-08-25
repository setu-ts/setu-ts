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
});
