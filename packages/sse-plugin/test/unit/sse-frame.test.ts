/**
 * Unit tests for the SSE frame encoder — pure, spec-shaped output.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { encodeSseComment, encodeSseMessage } from '../../src/utils/sse-frame.ts';

describe('encodeSseMessage', () => {
  it('should encode a simple string data message', () => {
    const result = encodeSseMessage({ data: 'hello' });
    expect(result).toBe('data: hello\n\n');
  });

  it('should encode multiline data as multiple data: lines', () => {
    const result = encodeSseMessage({ data: 'a\nb' });
    expect(result).toBe('data: a\ndata: b\n\n');
  });

  it('should encode an object data as JSON', () => {
    const result = encodeSseMessage({ data: { n: 1 } });
    expect(result).toBe('data: {"n":1}\n\n');
  });

  it('should include id field', () => {
    const result = encodeSseMessage({ id: '1', data: 'hello' });
    expect(result).toBe('id: 1\ndata: hello\n\n');
  });

  it('should include event field', () => {
    const result = encodeSseMessage({ event: 'tick', data: 'hello' });
    expect(result).toBe('event: tick\ndata: hello\n\n');
  });

  it('should include id and event together', () => {
    const result = encodeSseMessage({ id: '1', event: 'tick', data: { n: 1 } });
    expect(result).toBe('id: 1\nevent: tick\ndata: {"n":1}\n\n');
  });

  it('should include retry field', () => {
    const result = encodeSseMessage({ data: 'hello', retry: 5000 });
    expect(result).toBe('data: hello\nretry: 5000\n\n');
  });

  it('should omit id when not set', () => {
    const result = encodeSseMessage({ data: 'hello' });
    expect(result).not.toContain('id:');
  });

  it('should omit event when not set', () => {
    const result = encodeSseMessage({ data: 'hello' });
    expect(result).not.toContain('event:');
  });

  it('should omit retry when not set', () => {
    const result = encodeSseMessage({ data: 'hello' });
    expect(result).not.toContain('retry:');
  });

  it('should throw TypeError for undefined data', () => {
    // @ts-expect-error — intentionally testing undefined data
    expect(() => encodeSseMessage({ data: undefined })).toThrow(TypeError);
  });

  it('should terminate with exactly two newlines', () => {
    const result = encodeSseMessage({ data: 'hello' });
    expect(result.endsWith('\n\n')).toBe(true);
  });
});

describe('encodeSseComment', () => {
  it('should encode a comment frame', () => {
    const result = encodeSseComment('heartbeat');
    expect(result).toBe(': heartbeat\n\n');
  });

  it('should encode a comment with spaces', () => {
    const result = encodeSseComment('keepalive');
    expect(result).toBe(': keepalive\n\n');
  });

  it('should terminate with exactly two newlines', () => {
    const result = encodeSseComment('test');
    expect(result.endsWith('\n\n')).toBe(true);
  });
});
