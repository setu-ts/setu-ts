import { z } from 'zod';

/** A document to index; the id is the caller's and re-ingesting it replaces its chunks. */
export const IngestDocumentsBody = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  text: z.string().min(1).max(65_536),
  tag: z.string().min(1).max(64).optional(),
});
export type IngestDocumentsBody = z.infer<typeof IngestDocumentsBody>;
export const DocumentsAcceptedResponse = z.object({ id: z.string(), status: z.literal('queued') });
export type DocumentsAcceptedResponse = z.infer<typeof DocumentsAcceptedResponse>;
export const SearchDocumentsQuery = z.object({
  q: z.string().min(1).max(1_000),
  tag: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type SearchDocumentsQuery = z.infer<typeof SearchDocumentsQuery>;
export const DocumentsMatch = z.object({
  documentId: z.string(),
  chunk: z.string(),
  score: z.number(),
  tag: z.string().optional(),
});
export type DocumentsMatch = z.infer<typeof DocumentsMatch>;
export const DocumentsSearchResponse = z.object({ matches: z.array(DocumentsMatch) });
export type DocumentsSearchResponse = z.infer<typeof DocumentsSearchResponse>;
