/** Reads the OpenAPI document from a started application, a file, or HTTP. @module */
import type { IOpenApiService } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { withStartedApp, type PluginCommandDependencies } from '../commands/plugin-commands.ts';
import type { ICliFileSystem } from '../utils/file-writer.ts';
import { resolveDir } from '../utils/file-writer.ts';
import { escapeName } from '../utils/names.ts';

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** The effects used to read a document; --input never invokes the app loader. */
export interface IClientDocumentDependencies extends PluginCommandDependencies {
  readonly fs: ICliFileSystem;
  readonly fetch?: typeof globalThis.fetch;
}

/** Counts streamed bytes before decoding, and closes an over-limit source. */
async function readDocumentStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_DOCUMENT_BYTES) throw new Error('OpenAPI document is larger than 16 MiB.');
      chunks.push(next.value);
    }
  } catch (cause) {
    await reader.cancel(cause);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Objects at the document boundary exclude arrays and null. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses only JSON OpenAPI 3.x documents, naming the failed precondition. */
function parseDocument(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('OpenAPI document is larger than 16 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error('OpenAPI input must be valid JSON; YAML is not accepted.', { cause });
  }
  if (!isObject(value)) throw new Error('OpenAPI document must be an object.');
  if (typeof value['openapi'] !== 'string' || !value['openapi'].startsWith('3.'))
    throw new Error('OpenAPI document.openapi must be a string starting with 3.');
  if (!isObject(value['paths'])) throw new Error('OpenAPI document.paths must be an object.');
  return value;
}

/** Reads a bounded regular file through the CLI filesystem. */
async function readDocumentFile(fs: ICliFileSystem, path: string): Promise<Uint8Array> {
  const stat = await fs.stat(path);
  if (!stat.isFile) throw new Error(`${escapeName(path)} is not a regular file.`);
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('OpenAPI document is larger than 16 MiB.');
  if (fs.readRegularFile !== undefined) return fs.readRegularFile(path, MAX_DOCUMENT_BYTES);
  if (fs.readStream !== undefined) return readDocumentStream(await fs.readStream(path));
  return fs.readFile(path);
}

/**
 * Reads the project's document, booting without a port only when input is absent.
 * @param deps - Filesystem, app loader, fetch and output sinks
 * @param dir - The target project root
 * @param config - Optional application module override
 * @param input - A saved JSON path (relative to CWD) or HTTP(S) URL
 * @returns The document supplied to the project's generator
 */
export async function readClientDocument(
  deps: IClientDocumentDependencies,
  dir: string,
  config: string | undefined,
  input: string | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  if (input === undefined)
    return withStartedApp(deps, dir, config, 'client', (app) => {
      if (!app.services.has(CAPABILITIES.OPENAPI))
        throw new Error(
          'openapi-plugin is not registered in this application. Add it with `setu add openapi`, or pass `--input`.',
        );
      return app.services.get<IOpenApiService>(CAPABILITIES.OPENAPI).getSpec();
    });
  if (/^https?:\/\//.test(input)) {
    const response = await (deps.fetch ?? globalThis.fetch)(input, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cannot read OpenAPI input: HTTP ${response.status}.`);
    }
    return parseDocument(
      response.body === null ? new Uint8Array() : await readDocumentStream(response.body),
    );
  }
  return parseDocument(await readDocumentFile(deps.fs, resolveDir(deps.cwd, input)));
}
