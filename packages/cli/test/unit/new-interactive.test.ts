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

describe('resolveNewChoices', () => {
  it('returns the input unchanged when no prompter is supplied', async () => {
    const args = parseArgs(['svc']);
    expect(await resolveNewChoices(args, undefined, () => {})).toBe(args);
  });

  it('asks runtime, template, broker and queue for a bare standalone scaffold', async () => {
    const { args, questions } = await resolve(['svc'], ['deno', 'microservice', 'redis', 'redis']);
    expect(questions).toEqual(['Runtime?', 'Template?', 'Message broker?', 'Job queue?']);
    expect(args.flags['runtime']).toBe('deno');
    expect(args.flags['template']).toBe('microservice');
    expect(args.flags['broker']).toBe('redis');
    expect(args.flags['queue']).toBe('redis');
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
    const { args, questions } = await resolve(['svc'], ['deno', 'rest']);
    expect(questions).toEqual(['Runtime?', 'Template?']);
    expect(args.flags['broker']).toBeUndefined();
  });

  it('skips the broker and queue questions on Cloudflare Workers', async () => {
    // The Workers swap has already removed the wirings a broker arm would
    // rewrite — the same fact the command's refusal names.
    const { questions } = await resolve(
      ['svc', '--template', 'microservice'],
      ['cloudflare-workers'],
    );
    expect(questions).toEqual(['Runtime?']);
  });

  it('leaves later flags absent but still asked when one answer is EOF', async () => {
    const { args, questions } = await resolve(['svc'], [undefined, 'microservice', 'redis']);
    expect(questions).toEqual(['Runtime?', 'Template?', 'Message broker?', 'Job queue?']);
    expect(args.flags['runtime']).toBeUndefined();
    expect(args.flags['broker']).toBe('redis');
    expect(args.flags['queue']).toBeUndefined();
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
});
