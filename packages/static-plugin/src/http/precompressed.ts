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
 * Checks if a compression format is acceptable based on Accept-Encoding.
 *
 * @param acceptEncoding - The Accept-Encoding header value
 * @param format - The compression format to check
 * @returns True if the format is acceptable
 * @since 0.1.0
 */
export function isEncodingAcceptable(acceptEncoding: string, format: string): boolean {
  const encoding = CONTENT_ENCODINGS[format] ?? format;
  const encodings = acceptEncoding
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');

  // Check for the specific encoding or wildcard
  return encodings.includes(encoding) || encodings.includes('*');
}

/**
 * Finds the best available precompressed sidecar for a file.
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
