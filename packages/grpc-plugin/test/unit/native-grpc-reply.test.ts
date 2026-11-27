import { expect, it } from 'vitest';
import { nativeGrpcReply } from '../../src/transports/native-grpc-reply.ts';
import { checkResponseCancel } from '../fixtures/response-cancel.ts';

it('aborts a canceled native reply before returning the blocked iterator, with no cleanup bound', async () => {
  await checkResponseCancel(
    (body, abort) =>
      nativeGrpcReply({ status: 200, body }, abort).body as ReadableStream<Uint8Array>,
  );
});
it('resolves trailers on exhaustion and rejects them on iterator failure or cancellation', async () => {
  const headers = new Headers({ 'grpc-status': '0' });
  const reply = nativeGrpcReply({ status: 200, trailer: headers });
  await new Response(reply.body as ReadableStream<Uint8Array>).arrayBuffer();
  expect(await reply.trailers).toBe(headers);
  const failure = new Error('body failed');
  const failed = nativeGrpcReply({
    status: 200,
    body: {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
    },
  });
  await expect(new Response(failed.body as ReadableStream<Uint8Array>).arrayBuffer()).rejects.toBe(
    failure,
  );
  await expect(failed.trailers).rejects.toBe(failure);
  const empty = nativeGrpcReply({ status: 200 });
  await new Response(empty.body as ReadableStream<Uint8Array>).arrayBuffer();
  expect([...(await empty.trailers)!.keys()]).toEqual([]);
});
