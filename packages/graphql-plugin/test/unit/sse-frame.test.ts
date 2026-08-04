/**
 * Tests for transports/sse/sse-frame.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  encodeSseComment,
  encodeSseComplete,
  encodeSseEvent,
} from '../../src/transports/sse/sse-frame.ts';

const decoder = new TextDecoder();

describe('encodeSseEvent', () => {
  it('encodes data as SSE event with event: next', () => {
    const data = { data: { hello: 'world' } };
    const bytes = encodeSseEvent(data);
    const text = decoder.decode(bytes);
    expect(text).toBe('event: next\ndata: {"data":{"hello":"world"}}\n\n');
  });

  it('encodes error result with event: next', () => {
    const data = { errors: [{ message: 'field error' }] };
    const bytes = encodeSseEvent(data);
    const text = decoder.decode(bytes);
    expect(text).toBe('event: next\ndata: {"errors":[{"message":"field error"}]}\n\n');
  });

  it('handles multi-line JSON without breaking frame', () => {
    const data = { data: { nested: { a: 1, b: 2 } } };
    const bytes = encodeSseEvent(data);
    const text = decoder.decode(bytes);
    // Should start with event: next, then a single data line, followed by double newline
    const lines = text.split('\n');
    expect(lines[0]).toBe('event: next');
    expect(lines[1].startsWith('data: ')).toBe(true);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('');
  });
});

describe('encodeSseComplete', () => {
  it('encodes complete event with mandatory empty data field', () => {
    const bytes = encodeSseComplete();
    const text = decoder.decode(bytes);
    expect(text).toBe('event: complete\ndata: \n\n');
  });

  it('has empty data: field (required by EventSource)', () => {
    const bytes = encodeSseComplete();
    const text = decoder.decode(bytes);
    expect(text.includes('data: ')).toBe(true);
    // The data line should be exactly "data: " with nothing after
    const dataLine = text.split('\n')[1];
    expect(dataLine).toBe('data: ');
  });
});

describe('encodeSseComment', () => {
  it('encodes keep-alive comment', () => {
    const bytes = encodeSseComment();
    const text = decoder.decode(bytes);
    expect(text).toBe(':keep-alive\n\n');
  });

  it('starts with colon (SSE comment)', () => {
    const bytes = encodeSseComment();
    const text = decoder.decode(bytes);
    expect(text.startsWith(':')).toBe(true);
  });
});
