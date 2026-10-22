import { z } from 'zod';

/** The RFC 9457 error body the REST starter answers every failure with. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;
