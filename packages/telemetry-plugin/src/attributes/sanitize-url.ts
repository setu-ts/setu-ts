/** Builds the URL attribute emitted by request spans. */

import type { IRedactionService } from '@setu-ts/common';

/** Query-string handling mode for telemetry URLs. */
export type QueryParametersMode = 'omit' | 'redact';

/**
 * Removes URL fragments and, by default, query parameters before telemetry export.
 *
 * @param url - Request URL
 * @param mode - Query-string handling mode
 * @param redaction - Optional service for query values in `'redact'` mode
 * @returns The safe URL attribute
 */
export function sanitizeUrl(
  url: string,
  mode: QueryParametersMode,
  redaction: IRedactionService | undefined,
): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (mode === 'omit' || redaction === undefined) {
      parsed.search = '';
      return parsed.toString();
    }
    const parameters = [...parsed.searchParams.entries()];
    parsed.search = '';
    for (const [name, value] of parameters) {
      parsed.searchParams.append(name, String(redaction.redactValue(`query.${name}`, value)));
    }
    return parsed.toString();
  } catch {
    const queryIndex = url.indexOf('?');
    const fragmentIndex = url.indexOf('#');
    const end = [queryIndex, fragmentIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    return end === undefined ? url : url.slice(0, end);
  }
}
