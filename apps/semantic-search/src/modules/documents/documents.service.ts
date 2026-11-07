import { embed, embedMany } from 'ai';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry, IVectorStore, VectorRecord } from '@setu-ts/common';
import { EMBEDDINGS } from '../../plugins/embeddings.plugin.ts';
import type { IEmbeddingsService } from '../../plugins/embeddings.plugin.ts';
import type {
  DocumentsSearchResponse,
  IngestDocumentsBody,
  SearchDocumentsQuery,
} from './documents.schemas.ts';

/** The collection `setu.config.ts` declares, with `tag` as its one filterable field. */
export const DOCUMENTS_COLLECTION = 'documents';

/** Target chunk length in characters; one chunk is one vector. */
const CHUNK_SIZE = 800;

/** What indexing and search need, resolved once the plugins have registered. */
export interface DocumentsDependencies {
  readonly store: IVectorStore;
  readonly embeddings: IEmbeddingsService;
}

/** Resolves the store and the embedding model from the service registry. */
export function documentsDependencies(services: IServiceRegistry): DocumentsDependencies {
  return {
    store: services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE),
    embeddings: services.get<IEmbeddingsService>(EMBEDDINGS),
  };
}

/**
 * Splits text into chunks of about {@linkcode CHUNK_SIZE} characters, on
 * paragraph and then word boundaries; a single longer word is cut.
 */
export function splitText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    if (current !== '' && current.length + 1 + word.length > CHUNK_SIZE) {
      chunks.push(current);
      current = '';
    }
    for (let start = 0; start < word.length;) {
      let end = Math.min(start + CHUNK_SIZE, word.length);
      // Never cut a surrogate pair: the store refuses ill-formed text.
      if (end < word.length && /[\uD800-\uDBFF]/.test(word[end - 1]!)) end -= 1;
      const piece = word.slice(start, end);
      start = end;
      current = current === '' ? piece : `${current} ${piece}`;
      if (current.length >= CHUNK_SIZE) {
        chunks.push(current);
        current = '';
      }
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * Embeds a document's chunks and replaces every chunk it had before, so a
 * re-ingested or shortened document leaves no stale chunk behind. The write
 * is refused with `VectorVersionConflictError` when a newer version of the
 * document is already stored.
 *
 * @param version - The submission's version
 * @returns The number of chunks stored
 */
export async function indexDocument(
  deps: DocumentsDependencies,
  scope: string,
  document: IngestDocumentsBody,
  version: number,
): Promise<number> {
  const chunks = splitText(document.text);
  const { embeddings } = await embedMany({ model: deps.embeddings.model, values: chunks });
  const records: VectorRecord[] = chunks.map((chunk, index) => ({
    id: `${document.id}#${index}`,
    vector: embeddings[index]!,
    sourceId: document.id,
    content: chunk,
    ...(document.tag === undefined ? {} : { metadata: { tag: document.tag } }),
  }));
  await deps.store.replaceSource(DOCUMENTS_COLLECTION, scope, document.id, records, { version });
  return records.length;
}

/** Embeds the query and returns the closest chunks within the scope. */
export async function searchDocuments(
  deps: DocumentsDependencies,
  scope: string,
  query: SearchDocumentsQuery,
): Promise<DocumentsSearchResponse> {
  const { embedding } = await embed({ model: deps.embeddings.model, value: query.q });
  const matches = await deps.store.query(DOCUMENTS_COLLECTION, scope, {
    vector: embedding,
    topK: query.limit,
    ...(query.tag === undefined ? {} : { filter: { field: 'tag', op: 'eq', value: query.tag } }),
  });
  return {
    matches: matches.map((match) => ({
      documentId: match.sourceId ?? match.id,
      chunk: match.content ?? '',
      score: match.score,
      ...(typeof match.metadata['tag'] === 'string' ? { tag: match.metadata['tag'] } : {}),
    })),
  };
}
