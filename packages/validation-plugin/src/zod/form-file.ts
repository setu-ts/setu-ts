import { z } from 'zod';
import type { FormFile } from '@setu-ts/common';
import { withFormFileMetadata } from '@setu-ts/common';

/** Constraints on a parsed form file. @since 0.13.0 */
export interface FormFileOptions {
  /** Accepted client-claimed MIME essences (type/subtype or type/*). */
  readonly mimeTypes?: readonly string[];
  /** Maximum parsed byte length, a positive safe integer. */
  readonly maxBytes?: number;
}

// RFC 9110 token characters, with a wildcard permitted only as the whole subtype.
const MIME_ESSENCE = /^[!#$%&'+.^_`|~0-9a-z-]+\/(?:[!#$%&'+.^_`|~0-9a-z-]+|\*)$/i;

// A part's own type: one `type/subtype` essence, no wildcard. A value that is
// not one media type — a comma list (`image/png, text/html`, which the Fetch
// MIME extraction reads as its LAST type), a control character, an empty
// subtype — is refused before matching, so the allow-list judges the string the
// handler receives rather than a prefix of it.
const PART_ESSENCE = /^[!#$%&'+.^_`|~0-9a-z-]+\/[!#$%&'+.^_`|~0-9a-z-]+$/i;
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const UNSAFE_PART_TYPE = /[\u0000-\u001f\u007f,]/;

/**
 * Validates a parsed FormFile and records its constraints for documentation.
 * Filenames and MIME types are client supplied; neither is trusted or sniffed.
 * @param options - Accepted MIME types and maximum parsed byte length
 * @returns A Zod schema with FormFile input and output
 * @throws {TypeError} When an option is invalid
 * @example formFile({ mimeTypes: ['image/*'], maxBytes: 1_000_000 });
 * @since 0.13.0
 */
export function formFile(options?: FormFileOptions): z.ZodCustom<FormFile, FormFile> {
  const mimeTypes = options?.mimeTypes?.map((entry) => {
    if (typeof entry !== 'string' || !MIME_ESSENCE.test(entry)) {
      throw new TypeError(`Invalid mimeTypes entry: ${String(entry)}`);
    }
    return entry.toLowerCase();
  });
  if (mimeTypes?.length === 0) throw new TypeError('Invalid mimeTypes: empty array');
  const maxBytes = options?.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new TypeError(`Invalid maxBytes: ${String(maxBytes)}`);
  }
  const schema = z
    .custom<FormFile>(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        'filename' in value &&
        typeof value.filename === 'string' &&
        'mimeType' in value &&
        typeof value.mimeType === 'string' &&
        'data' in value &&
        value.data instanceof Uint8Array,
      { message: 'Expected a file' },
    )
    .superRefine((file, ctx) => {
      const essence = file.mimeType.split(';', 1)[0]!.trim().toLowerCase();
      if (
        mimeTypes !== undefined &&
        (UNSAFE_PART_TYPE.test(file.mimeType) ||
          !PART_ESSENCE.test(essence) ||
          !mimeTypes.some(
            (type) =>
              type === essence || (type.endsWith('/*') && essence.startsWith(type.slice(0, -1))),
          ))
      ) {
        // The client's type is not echoed: it is client-chosen text.
        ctx.addIssue({ code: 'custom', message: 'File type is not accepted' });
      }
      if (maxBytes !== undefined && file.data.byteLength > maxBytes) {
        ctx.addIssue({ code: 'custom', message: `File exceeds ${maxBytes} bytes` });
      }
    });
  return withFormFileMetadata(schema, {
    ...(mimeTypes === undefined ? {} : { mimeTypes }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
}
