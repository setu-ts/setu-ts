/**
 * Precompressed sidecar negotiation for static file serving.
 *
 * @module
 */

import type { IFileSystem, StatResult } from '@setu-ts/common';
import { contentTypeFor } from '@setu-ts/common';

/**
 * Supported compression formats in preference order.
 *
 * @since 0.1.0
 */
export const COMPRESSION_FORMATS = ['br', 'gz'] as const;

/**
 * Content encodings for each compression format.
 *
 * @since 0.1.0
 */
export const CONTENT_ENCODINGS: Record<string, string> = {
  br: 'br',
  gz: 'gzip',
};

/**
 * Options for precompressed sidecar negotiation.
 *
 * @since 0.1.0
 */
export type PrecompressedOptions = {
  /** The filesystem to use */
  fs: IFileSystem;
  /** The original file path */
  originalPath: string;
  /** The original file stat */
  originalStat: StatResult;
  /** The Accept-Encoding header value */
  acceptEncoding?: string | undefined;
};

/**
 * Parses Accept-Encoding header into a list of encoding preferences with quality values.
 *
 * Handles:
 * - Wildcard `*` (matches any encoding)
 * - Quality values (`gzip;q=0.5`, `br;q=1.0`)
 * - Identity `identity` (explicitly requested)
 * - Multiple comma-separated values
 *
 * @param acceptEncoding - The Accept-Encoding header value
 * @returns Array of { encoding, quality } sorted by quality descending
 * @since 0.1.0
 */
export function parseAcceptEncoding(
  acceptEncoding: string,
): Array<{ encoding: string; quality: number }> {
  return acceptEncoding
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
    .map((e) => {
      const parts = e.split(';');
      const encoding = parts[0].trim().toLowerCase();
      let quality = 1.0;
      for (const part of parts.slice(1)) {
        const qMatch = /^q\s*=\s*([0-9]*\.?[0-9]+)$/.exec(part.trim());
        if (qMatch) {
          quality = parseFloat(qMatch[1]);
        }
      }
      return { encoding, quality };
    })
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Checks if a compression format is acceptable based on Accept-Encoding.
 *
 * @param acceptEncoding - The Accept-Encoding header value
 * @param format - The compression format to check ('br' or 'gz')
 * @returns True if the format is acceptable
 * @since 0.1.0
 */
export function isEncodingAcceptable(acceptEncoding: string, format: string): boolean {
  const encoding = CONTENT_ENCODINGS[format] ?? format;
  const parsed = parseAcceptEncoding(acceptEncoding);

  // An explicit entry for this encoding always wins over the wildcard, whatever
  // the quality ordering. `br;q=0, *` REJECTS brotli — scanning in quality order
  // would hit the wildcard first and wrongly accept it (RFC 9110 §12.5.3).
  const explicit = parsed.find(({ encoding: enc }) => enc === encoding);
  if (explicit) {
    return explicit.quality > 0;
  }

  return parsed.some(({ encoding: enc, quality }) => enc === '*' && quality > 0);
}

/**
 * Finds the best available precompressed sidecar for a file.
 *
 * Probes sidecars in preference order (.br first, then .gz) and returns the
 * first one whose encoding is acceptable per Accept-Encoding.
 *
 * @param options - Precompressed options
 * @returns The sidecar path and format, or null if none found
 * @since 0.1.0
 */
export async function findPrecompressedSidecar(
  options: PrecompressedOptions,
): Promise<{ path: string; format: string; stat: StatResult } | null> {
  const { fs, originalPath, acceptEncoding } = options;

  if (!acceptEncoding) {
    return null;
  }

  // Try each compression format in preference order
  for (const format of COMPRESSION_FORMATS) {
    const sidecarPath = `${originalPath}.${format}`;

    try {
      const sidecarStat = await fs.stat(sidecarPath);
      if (sidecarStat.isFile && isEncodingAcceptable(acceptEncoding, format)) {
        return { path: sidecarPath, format, stat: sidecarStat };
      }
    } catch {
      // Sidecar doesn't exist, try next format
      continue;
    }
  }

  return null;
}

/**
 * Gets the content type for the original file.
 *
 * @param originalPath - The original file path
 * @returns The content type
 * @since 0.1.0
 */
export function getOriginalContentType(originalPath: string): string {
  return contentTypeFor(originalPath);
}
