import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseArgs } from '../../src/args.ts';
import { resolveNewChoices } from '../../src/commands/new-interactive.ts';
import type { PromptChoice, Prompter } from '../../src/prompt.ts';

/**
 * A scripted prompter: records every question in order and answers each from a
 * queue, exactly the way the plan's question-sequence table drives it.
 */
function scripted(answers: readonly (string | undefined)[]) {
  const questions: string[] = [];
  const queue = [...answers];
  const prompter: Prompter = {
    select(question: string, _choices: readonly PromptChoice[]): Promise<string | undefined> {
      questions.push(question);
      return Promise.resolve(queue.shift());
    },
  };
  return { prompter, questions };
}

async function resolve(argv: readonly string[], answers: readonly (string | undefined)[]) {
  const { prompter, questions } = scripted(answers);
  const args = await resolveNewChoices(parseArgs(argv), prompter, () => {});
  return { args, questions };
}

/**
 * Records the CHOICES each question offered, not just the question text.
 *
 * The scripted fake above discards them, which is why a prompt could offer a
 * value the command then refuses without any test noticing.
 */
async function offered(argv: readonly string[], answers: readonly (string | undefined)[]) {
  const menus = new Map<string, readonly string[]>();
  const queue = [...answers];
  const prompter: Prompter = {
    select(question: string, choices: readonly PromptChoice[]): Promise<string | undefined> {
      menus.set(question, choices.map((choice) => choice.value));
      return Promise.resolve(queue.shift());
    },
  };
  await resolveNewChoices(parseArgs(argv), prompter, () => {});
  return menus;
}

describe('resolveNewChoices', () => {
  it('returns the input unchanged when no prompter is supplied', async () => {
    const args = parseArgs(['svc']);
    expect(await resolveNewChoices(args, undefined, () => {})).toBe(args);
  });

  it('asks runtime, template, style, broker and queue for a bare standalone scaffold', async () => {
    const { args, questions } = await resolve(
      ['svc'],
      ['deno', 'microservice', 'functional', 'redis', 'redis'],
    );
    expect(questions).toEqual([
      'Runtime?',
      'Template?',
      'Code style?',
      'Message broker?',
      'Job queue?',
    ]);
    expect(args.flags['runtime']).toBe('deno');
    expect(args.flags['template']).toBe('microservice');
    expect(args.flags['style']).toBe('functional');
    expect(args.flags['broker']).toBe('redis');
    expect(args.flags['queue']).toBe('redis');
  });

  // A workspace cannot be hosted on Cloudflare Workers, and `planWorkspace`
  // refuses that pairing with exit 2 — so offering it here dead-ends the whole
  // session AFTER every question has been answered. The milestone's own stated
  // invariant is that a question whose answer would be refused is never asked;
  // it held for broker and queue and not for the very first question.
  it('never offers a runtime a workspace cannot be hosted on', async () => {
    const menus = await offered(['acme', '--workspace'], ['deno', 'http']);
    expect(menus.get('Runtime?')).toEqual(['deno', 'node', 'bun']);
  });

  it('still offers every runtime to a standalone project', async () => {
    const menus = await offered(['svc'], ['deno', 'minimal']);
    expect(menus.get('Runtime?')).toEqual(['deno', 'node', 'bun', 'cloudflare-workers']);
  });

  it('asks runtime and transport only for a workspace', async () => {
    const { args, questions } = await resolve(
      ['mono', '--workspace'],
      ['deno', 'rabbitmq'],
    );
    expect(questions).toEqual(['Runtime?', 'How should the workspace members reach each other?']);
    expect(args.flags['transport']).toBe('rabbitmq');
    expect(args.flags['broker']).toBeUndefined();
  });

  it('asks nothing when every flag is already supplied', async () => {
    const { questions } = await resolve(
      [
        'svc',
        '--runtime',
        'deno',
        '--template',
        'microservice',
        '--style',
        'functional',
        '--broker',
        'memory',
        '--queue',
        'memory',
      ],
      [],
    );
    expect(questions).toEqual([]);
  });

  it('skips the broker and queue questions for a template with no messaging wiring', async () => {
    const { args, questions } = await resolve(['svc'], ['deno', 'rest', 'functional']);
    expect(questions).toEqual(['Runtime?', 'Template?', 'Code style?']);
    expect(args.flags['broker']).toBeUndefined();
  });

  it('skips the broker and queue questions on Cloudflare Workers', async () => {
    // The Workers swap has already removed the wirings a broker arm would
    // rewrite — the same fact the command's refusal names.
    const { questions } = await resolve(
      ['svc', '--template', 'microservice'],
      ['cloudflare-workers', 'functional'],
    );
    expect(questions).toEqual(['Runtime?', 'Code style?']);
  });

  it('leaves later flags absent but still asked when one answer is EOF', async () => {
    const { args, questions } = await resolve(
      ['svc'],
      [undefined, 'microservice', 'functional', 'redis'],
    );
    expect(questions).toEqual([
      'Runtime?',
      'Template?',
      'Code style?',
      'Message broker?',
      'Job queue?',
    ]);
    expect(args.flags['runtime']).toBeUndefined();
    expect(args.flags['broker']).toBe('redis');
    expect(args.flags['queue']).toBeUndefined();
  });

  it('skips the style question for a template without a class-based variant', async () => {
    // full-stack composes through a starter and has no controller or ingress
    // seam, so it has no style axis at all.
    const { questions } = await resolve(['svc'], ['deno', 'full-stack']);
    expect(questions).toEqual(['Runtime?', 'Template?']);
  });

  it('skips the style question when --style was supplied on the command line', async () => {
    const { args, questions } = await resolve(
      ['svc', '--template', 'rest', '--style', 'class-based'],
      ['deno'],
    );
    expect(questions).toEqual(['Runtime?']);
    expect(args.flags['style']).toBe('class-based');
  });

  it('asks the style question for rest and microservice, with functional first', async () => {
    const menus = await offered(['svc', '--template', 'rest'], ['deno', 'class-based']);
    expect(menus.get('Code style?')).toEqual(['functional', 'class-based']);
    const microservice = await offered(
      ['svc', '--template', 'microservice'],
      ['deno', 'class-based'],
    );
    expect(microservice.get('Code style?')).toEqual(['functional', 'class-based']);
  });

  it('asks the broker and queue questions for microservice in class-based style', async () => {
    // The styled host still registers the messaging and queue wirings, so the
    // same predicate that refuses them elsewhere lets them through here.
    const { args, questions } = await resolve(
      ['svc', '--template', 'microservice', '--style', 'class-based'],
      ['deno', 'redis', 'redis'],
    );
    expect(questions).toEqual(['Runtime?', 'Message broker?', 'Job queue?']);
    expect(args.flags['broker']).toBe('redis');
    expect(args.flags['queue']).toBe('redis');
  });

  it('skips the broker and queue questions for an unknown template name', async () => {
    // The pipeline refuses the name below with its own message; prompting a
    // question whose every answer would be refused helps nobody.
    const { args, questions } = await resolve(['svc'], ['deno', 'nope']);
    expect(questions).toEqual(['Runtime?', 'Template?']);
    expect(args.flags['broker']).toBeUndefined();
  });

  it('skips an already-supplied workspace transport', async () => {
    const { questions } = await resolve(
      ['mono', '--workspace', '--transport', 'rabbitmq'],
      ['bun'],
    );
    expect(questions).toEqual(['Runtime?']);
  });

  it('asks everything and sets nothing when every answer is EOF', async () => {
    // The minimal-host path: no template collected, so the broker and queue
    // questions are skipped under the same predicate that refuses them.
    const { args, questions } = await resolve(['svc'], [undefined, undefined]);
    expect(questions).toEqual(['Runtime?', 'Template?']);
    expect(args.flags['runtime']).toBeUndefined();
    expect(args.flags['template']).toBeUndefined();
    expect(args.flags['broker']).toBeUndefined();
  });

  it('defaults the Template question to the minimal arm, not the first registry entry', async () => {
    // Bare Enter takes the FIRST choice, so the default arm must be spelled
    // first and must record NOTHING: an absent --template is how the pipeline
    // reaches MINIMAL_HOST, exactly what --yes takes. The registry starts with
    // `rest`, which used to leak through as the interactive default.
    const seen: Record<string, readonly PromptChoice[]> = {};
    const prompter: Prompter = {
      select(question, choices) {
        seen[question] = choices;
        return Promise.resolve('minimal');
      },
    };
    const args = await resolveNewChoices(parseArgs(['svc']), prompter, () => {});
    // The class-based alias is omitted: two names for one project with nothing
    // telling them apart is what the alias annotation exists to prevent.
    expect(seen['Template?']?.map((choice) => choice.value)).toEqual([
      'minimal',
      'rest',
      'microservice',
      'full-stack',
    ]);
    expect(args.flags['template']).toBeUndefined();
  });
});
