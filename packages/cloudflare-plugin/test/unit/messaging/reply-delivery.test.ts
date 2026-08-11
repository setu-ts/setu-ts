/**
 * `deliverReply` must never throw. It runs inside a queue-consumer invocation
 * whose message still has to be acked: an escaping failure would retry the
 * request, re-running a responder whose side effects already landed, once per
 * retry until the queue dead-lettered it.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IDurableObjectNamespace, IServiceBinding } from '../../../src/bindings/facades.ts';
import { encodeReplyEnvelope } from '../../../src/messaging/message-envelope.ts';
import { deliverReply } from '../../../src/messaging/reply-delivery.ts';
import { RecordingLogger } from '../../fakes.ts';

/** A recorded delivery attempt. */
interface RecordedDelivery {
  readonly name: string;
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A namespace whose stub answers with a fixed status, or throws. */
function namespaceAnswering(
  answer: { readonly status: number } | { readonly throws: string },
): { namespace: IDurableObjectNamespace; deliveries: RecordedDelivery[] } {
  const deliveries: RecordedDelivery[] = [];
  const namespace: IDurableObjectNamespace = {
    idFromName: (name: string): unknown => name,
    get: (id: unknown): IServiceBinding => ({
      fetch: (input: Request | string, init?: RequestInit): Promise<Response> => {
        deliveries.push({
          name: String(id),
          url: typeof input === 'string' ? input : input.url,
          init,
        });
        if ('throws' in answer) return Promise.reject(new Error(answer.throws));
        return Promise.resolve(new Response(null, { status: answer.status }));
      },
    }),
  };
  return { namespace, deliveries };
}

const REPLY = encodeReplyEnvelope('corr-1', { ok: true, payload: 3 });

describe('deliverReply', () => {
  it('posts the reply as JSON to the object the request named', async () => {
    const { namespace, deliveries } = namespaceAnswering({ status: 200 });

    await deliverReply(namespace, 'rr.inbox.abc', REPLY);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.name).toBe('rr.inbox.abc');
    expect(deliveries[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(deliveries[0]?.init?.body))).toEqual({
      v: 1,
      kind: 'rpc-reply',
      correlationId: 'corr-1',
      ok: true,
      payload: 3,
    });
  });

  it('reports a refused delivery without throwing', async () => {
    const { namespace } = namespaceAnswering({ status: 500 });
    const logger = new RecordingLogger();

    await expect(deliverReply(namespace, 'rr.inbox.abc', REPLY, () => logger))
      .resolves.toBeUndefined();

    expect(logger.messages()).toEqual([
      'cloudflare-messaging: reply inbox refused a delivery',
    ]);
    expect(logger.records[0]?.meta).toMatchObject({ replyTo: 'rr.inbox.abc', status: 500 });
  });

  it('reports a transport failure without throwing', async () => {
    const { namespace } = namespaceAnswering({ throws: 'namespace unreachable' });
    const logger = new RecordingLogger();

    await expect(deliverReply(namespace, 'rr.inbox.abc', REPLY, () => logger))
      .resolves.toBeUndefined();

    expect(logger.messages()).toEqual(['cloudflare-messaging: reply delivery failed']);
    expect(logger.records[0]?.meta).toMatchObject({ error: 'namespace unreachable' });
  });

  it('reports a non-Error rejection without throwing', async () => {
    const deliveries: RecordedDelivery[] = [];
    const namespace: IDurableObjectNamespace = {
      idFromName: (name: string): unknown => name,
      get: (): IServiceBinding => ({
        // Workers surfaces some internal failures as non-Error values.
        fetch: (): Promise<Response> => Promise.reject('binding revoked'),
      }),
    };
    const logger = new RecordingLogger();

    await expect(deliverReply(namespace, 'rr.inbox.abc', REPLY, () => logger))
      .resolves.toBeUndefined();

    expect(logger.records[0]?.meta).toMatchObject({ error: 'binding revoked' });
    expect(deliveries).toEqual([]);
  });

  it('stays silent, and still does not throw, with no logger', async () => {
    const { namespace } = namespaceAnswering({ throws: 'namespace unreachable' });
    await expect(deliverReply(namespace, 'rr.inbox.abc', REPLY)).resolves.toBeUndefined();
  });

  it('reads the logger through the thunk at failure time, not at call time', async () => {
    const { namespace } = namespaceAnswering({ status: 503 });
    // A holder, so the source closes over a slot that is still EMPTY when it is
    // built — which is the condition the thunk exists for.
    const holder: { logger?: RecordingLogger } = {};
    const source = (): RecordingLogger | undefined => holder.logger;

    // Registered AFTER the delivery function was handed its source — the M52b
    // defect this thunk exists to prevent.
    holder.logger = new RecordingLogger();
    await deliverReply(namespace, 'rr.inbox.abc', REPLY, source);

    expect(holder.logger.messages()).toHaveLength(1);
  });
});
