import { MockLanguageModelV4 } from 'ai/test';
import type { CallWarning } from 'ai';
import { overrideCapability } from '@setu-ts/testing';
import { SUPPORT_MODEL } from '../../src/plugins/support-model.plugin.ts';
import type { ISupportModelService } from '../../src/plugins/support-model.plugin.ts';

type Part = Record<string, unknown>;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function stream(parts: readonly Part[]): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] as CallWarning[] } as never);
      for (const part of parts) controller.enqueue(part as never);
      controller.close();
    },
  });
}

function text(value: string): Part[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: value },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
}

function call(id: string, toolName: string, input: unknown): Part[] {
  return [
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
}

/** The tool results already in the prompt, oldest first. */
function results(prompt: readonly Part[]): Part[] {
  return prompt
    .filter((message) => message['role'] === 'tool')
    .flatMap((message) => message['content'] as Part[])
    .filter((part) => part['type'] === 'tool-result');
}

/**
 * A model that plays a fixed support conversation for order A-1001: look the
 * order up, ask to refund `amountCents`, then answer with the outcome. Each
 * step is chosen from the tool results in the prompt, so the model carries no
 * state and behaves the same after the process serving the run restarts.
 *
 * @param options - The refund amount, and an optional gate the model waits on before every call
 * @returns The model, and every prompt it was called with
 */
export function supportScript(options: { amountCents?: number; gate?: () => Promise<void> } = {}) {
  const prompts: Part[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      await options.gate?.();
      prompts.push(prompt as unknown as Part[]);
      const done = results(prompt as unknown as Part[]);
      const last = done.at(-1);
      if (done.length === 0)
        return { stream: stream(call('lookup-1', 'lookupOrder', { orderId: 'A-1001' })) };
      if (last?.['toolName'] === 'lookupOrder')
        return {
          stream: stream(
            call('refund-1', 'issueRefund', {
              orderId: 'A-1001',
              amountCents: options.amountCents ?? 4500,
              reason: 'Left ear cup rattles',
            }),
          ),
        };
      const output = last?.['output'] as Part | undefined;
      return {
        stream: stream(
          text(
            output?.['type'] === 'execution-denied'
              ? 'The refund was not approved, so nothing was refunded.'
              : 'Done: the refund has been issued.',
          ),
        ),
      };
    },
  });
  return { model, prompts };
}

/** The test override that installs a scripted model as the support model. */
export function withSupportModel(model: MockLanguageModelV4) {
  return overrideCapability(SUPPORT_MODEL, { model } satisfies ISupportModelService);
}
