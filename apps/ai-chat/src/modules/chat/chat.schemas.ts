import { z } from 'zod';

/** Input for one chat turn; identity never travels in the body. */
export const ChatBody = z.object({ prompt: z.string().min(1).max(10_000) });
export type ChatBody = z.infer<typeof ChatBody>;
