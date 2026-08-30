/**
 * Incremental parser for the Server-Sent Events wire format.
 *
 * This is an internal seam. The public SSE client feeds decoded fetch chunks
 * into it and owns JSON parsing, callbacks, and reconnect policy.
 *
 * @module
 */

/** One complete SSE record parsed at a blank-line boundary. */
export interface ParsedSseFrame {
  /** The event identifier when the record supplied one. */
  readonly id?: string;
  /** The event name when the record supplied one. */
  readonly event?: string;
  /** The joined raw data lines when the record supplied data. */
  readonly data?: string;
  /** The reconnection delay advertised by the server. */
  readonly retry?: number;
}

/**
 * Parses decoded chunks without assuming frame or UTF-8 boundaries align with
 * transport chunks. `TextDecoder` streaming belongs to the caller because it
 * owns the byte stream; this class receives decoded text only.
 */
export class SseFrameParser {
  #buffer = '';
  #firstChunk = true;
  #id: string | undefined;
  #event: string | undefined;
  #data: string[] = [];
  #retry: number | undefined;
  #hasField = false;

  /**
   * Feeds one decoded chunk and returns every completed record it contains.
   *
   * @param chunk - Decoded text from a streaming response body.
   * @returns Complete frames, in wire order.
   */
  push(chunk: string): readonly ParsedSseFrame[] {
    this.#buffer += this.#firstChunk ? stripLeadingBom(chunk) : chunk;
    // Only a chunk that carried text disarms the strip. A streaming decoder
    // returns '' when a transport chunk ends mid-sequence, and the BOM is three
    // bytes, so clearing unconditionally would let a split BOM through and
    // corrupt the first field name.
    if (chunk !== '') this.#firstChunk = false;

    const frames: ParsedSseFrame[] = [];
    let terminator = findLineTerminator(this.#buffer);
    while (terminator !== -1) {
      // A CR at the end of a chunk may be the first half of CRLF. Retain it
      // until the next chunk rather than manufacturing a second blank line.
      if (this.#buffer[terminator] === '\r' && terminator === this.#buffer.length - 1) break;

      const line = this.#buffer.slice(0, terminator);
      const width = this.#buffer[terminator] === '\r' && this.#buffer[terminator + 1] === '\n'
        ? 2
        : 1;
      this.#buffer = this.#buffer.slice(terminator + width);
      this.#consumeLine(line, frames);
      terminator = findLineTerminator(this.#buffer);
    }
    return frames;
  }

  #consumeLine(line: string, frames: ParsedSseFrame[]): void {
    if (line === '') {
      this.#dispatch(frames);
      return;
    }
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const valueStart = colon === -1 ? '' : line.slice(colon + 1);
    const value = valueStart.startsWith(' ') ? valueStart.slice(1) : valueStart;

    switch (field) {
      case 'data':
        this.#data.push(value);
        this.#hasField = true;
        break;
      case 'event':
        this.#event = value;
        this.#hasField = true;
        break;
      case 'id':
        if (!value.includes('\u0000')) {
          this.#id = value;
          this.#hasField = true;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
          this.#retry = Number(value);
          this.#hasField = true;
        }
        break;
    }
  }

  #dispatch(frames: ParsedSseFrame[]): void {
    if (!this.#hasField) return;
    const frame: ParsedSseFrame = {
      ...(this.#id === undefined ? {} : { id: this.#id }),
      ...(this.#event === undefined ? {} : { event: this.#event }),
      ...(this.#data.length === 0 ? {} : { data: this.#data.join('\n') }),
      ...(this.#retry === undefined ? {} : { retry: this.#retry }),
    };
    frames.push(frame);
    this.#id = undefined;
    this.#event = undefined;
    this.#data = [];
    this.#retry = undefined;
    this.#hasField = false;
  }
}

/** Removes the UTF-8 byte-order mark permitted only at stream start. */
function stripLeadingBom(value: string): string {
  return value.startsWith('\uFEFF') ? value.slice(1) : value;
}

/** Finds the first CR or LF, whichever appears first. */
function findLineTerminator(value: string): number {
  const cr = value.indexOf('\r');
  const lf = value.indexOf('\n');
  if (cr === -1) return lf;
  if (lf === -1) return cr;
  return Math.min(cr, lf);
}
