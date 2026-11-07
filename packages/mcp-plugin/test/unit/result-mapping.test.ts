import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod-v4';
import { mapResult, toolError } from '../../src/call/result-mapping.ts';
import { tool } from '../fixtures.ts';
const success = (text: string) => ({ content: [{ type: 'text', text }] });
const schema = z.object({ ok: z.boolean() });
const output = tool({ schema: { response: { 200: schema } } });
describe('result mapping table', () => {
  it.each([
    [
      'structured',
      200,
      'application/json',
      '{"ok":true}',
      true,
      { ...success('{"ok":true}'), structuredContent: { ok: true } },
    ],
    [
      'schema refusal',
      200,
      'application/json',
      '{"ok":"wrong"}',
      true,
      toolError('The tool returned a result that does not match its output schema.'),
    ],
    [
      'JSON',
      200,
      'application/json; charset=utf-8',
      '{ "ok": true }',
      false,
      success('{"ok":true}'),
    ],
    ['+json', 200, 'application/vendor+json', '{"ok":true}', false, success('{"ok":true}')],
    ['text', 200, 'text/plain', 'hello', false, success('hello')],
    ['empty', 204, '', '', false, success('')],
    [
      'binary',
      200,
      'image/png',
      'binary',
      false,
      toolError('The tool returned a result type it cannot deliver.'),
    ],
    [
      'redirect',
      302,
      'text/plain',
      'secret',
      false,
      toolError('The tool answered with a redirect, which is not followed.'),
    ],
    [
      'problem',
      422,
      'application/problem+json',
      '{"title":"Invalid","detail":"Fix it","errors":[{"field":"name","message":"Required","code":"x"}]}',
      false,
      toolError('Invalid: Fix it\nname: Required'),
    ],
    [
      'default error',
      400,
      'application/json',
      '{"error":"Bad","detail":"Invalid"}',
      false,
      toolError('Bad: Invalid'),
    ],
    ['no detail', 403, 'application/json', '{"title":"Forbidden"}', false, toolError('Forbidden')],
    [
      'bad error shape',
      404,
      'application/json',
      '{"message":"hidden"}',
      false,
      toolError('The request was refused (404).'),
    ],
    [
      'foreign errors',
      400,
      'application/json',
      '{"title":"Bad","errors":[null,{},7]}',
      false,
      toolError('Bad'),
    ],
    ['4xx text', 429, 'text/plain', 'private', false, toolError('The request was refused (429).')],
    [
      '4xx invalid JSON',
      400,
      'application/json',
      'invalid',
      false,
      toolError('The request was refused (400).'),
    ],
    [
      '5xx',
      500,
      'application/json',
      '{"title":"SECRET","stack":"STACK"}',
      false,
      toolError('The tool failed.'),
    ],
    [
      'invalid success JSON',
      200,
      'application/json',
      'invalid',
      false,
      toolError('The tool failed.'),
    ],
    [
      'array output',
      200,
      'application/json',
      '[]',
      true,
      toolError('The tool returned a result that does not match its output schema.'),
    ],
  ] as const)('%s', async (_name, status, type, body, hasSchema, expected) => {
    const response = new Response(status === 204 ? null : body, {
      status,
      headers: { 'content-type': type },
    });
    expect(
      await mapResult(response, hasSchema ? output : tool(), 1024, new AbortController().signal),
    ).toEqual(expected);
  });
  it('stops at the byte bound and cancels the stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(10));
      },
      cancel,
    });
    expect(await mapResult(new Response(stream), tool(), 9, new AbortController().signal)).toEqual(
      toolError('The tool result is too large.'),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('accepts the exact bound and a body with no media type is undeliverable', async () => {
    expect(
      await mapResult(new Response(new Uint8Array([65])), tool(), 1, new AbortController().signal),
    ).toEqual(toolError('The tool returned a result type it cannot deliver.'));
  });
});

it.each([false, true])(
  'cancels a pending read on abort and contains a rejecting cancel: %s',
  async (rejectCancel) => {
    const controller = new AbortController();
    const cancel = vi.fn(() =>
      rejectCancel ? Promise.reject(new Error('CANCEL SECRET')) : Promise.resolve(),
    );
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = mapResult(response, tool(), 1024, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(response.body!.locked).toBe(false);
  },
);

it.each([false, true])('refuses a pre-aborted result with a body: %s', async (body) => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const response = new Response(body ? new ReadableStream<Uint8Array>({ cancel }) : null);
  controller.abort();
  await expect(mapResult(response, tool(), 1024, controller.signal)).rejects.toBe(
    controller.signal.reason,
  );
  expect(cancel).toHaveBeenCalledTimes(body ? 1 : 0);
});

it('reads a fast stream fully and removes the abort listener', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('fast'));
        stream.close();
      },
      cancel,
    }),
    { headers: { 'content-type': 'text/plain' } },
  );
  expect(await mapResult(response, tool(), 1024, controller.signal)).toEqual(success('fast'));
  controller.abort();
  expect(cancel).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
