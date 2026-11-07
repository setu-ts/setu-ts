import { z } from 'zod';

/** Characters one earlier turn, and the whole history, may carry. */
const MAX_TURN_CHARS = 10_000;
const MAX_HISTORY_CHARS = 50_000;

/** One earlier turn the client resends; the server keeps no conversation. */
export const ChatTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_TURN_CHARS),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

/**
 * Input for one chat turn: the new `prompt`, and the conversation so far in
 * `history`, oldest first. Identity never travels in the body. The history is
 * the client's own text, so it is bounded here and priced as input like the prompt.
 */
export const ChatBody = z.object({
  prompt: z.string().min(1).max(MAX_TURN_CHARS),
  history: z
    .array(ChatTurn)
    .max(40)
    .refine(
      (turns) => turns.reduce((chars, turn) => chars + turn.content.length, 0) <= MAX_HISTORY_CHARS,
      `history may carry at most ${MAX_HISTORY_CHARS} characters`,
    )
    .optional(),
});
export type ChatBody = z.infer<typeof ChatBody>;

/** What `GET /chat/model` reports about the model behind `POST /chat`. */
export const ChatModelInfo = z.object({
  /** The context window in tokens, or `null` when `AI_COMPAT_CONTEXT_TOKENS` is unset. */
  contextTokens: z.number().int().positive().nullable(),
  /** The output-token limit each turn is called with. */
  maxOutputTokens: z.number().int().positive(),
});
export type ChatModelInfo = z.infer<typeof ChatModelInfo>;

/**
 * Token counts sent on the stream's `finish` event as message metadata. A
 * count the provider did not report is absent.
 */
export type ChatUsageMetadata = {
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
  };
};
