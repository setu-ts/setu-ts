/**
 * The inbox is the only path a reply can take, so a drop dooms every in-flight
 * request — which is why `onClosed` exists and why closing deliberately must
 * NOT fire it. Getting that backwards would reject the caller's own teardown.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { openReplyInbox } from '../../../src/messaging/reply-inbox.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';
import { SequentialIds } from '../../fakes.ts';

/** Opens an inbox over a namespace backed by the real reply-inbox core. */
async function open(namespace: FakeDurableObjectNamespace, received: string[] = [], closed = {
  count: 0,
}): Promise<{ address: string; close: () => Promise<void> }> {
  const ids = new SequentialIds();
  return await openReplyInbox({
    namespace,
    binding: 'REPLY_INBOX',
    uuid: () => ids.uuid(),
    onReply: (raw) => {
      received.push(raw);
    },
    onClosed: () => {
      closed.count += 1;
    },
  });
}

describe('openReplyInbox', () => {
  it('addresses the object by a per-instance name', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const inbox = await open(namespace);

    expect(inbox.address).toBe('rr.inbox.id-1');
    // Two isolates must never share an inbox, or one would receive the other's
    // replies — so the address is the id, not a fixed string.
    expect(namespace.requestedNames).toEqual(['rr.inbox.id-1']);
  });

  it('accepts the socket, so the runtime delivers messages to this isolate', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    await open(namespace);

    expect(namespace.clients[0]?.accepted).toBe(true);
  });

  it('routes an arriving reply to onReply', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const received: string[] = [];
    const inbox = await open(namespace, received);

    const stub = namespace.get(namespace.idFromName(inbox.address));
    await stub.fetch('https://reply-inbox.internal/deliver', {
      method: 'POST',
      body: '{"ok":true}',
    });

    expect(received).toEqual(['{"ok":true}']);
  });

  it('ignores a binary frame, which no responder sends', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const received: string[] = [];
    await open(namespace, received);

    namespace.clients[0]?.receive(new ArrayBuffer(4));

    expect(received).toEqual([]);
  });

  it('reports a dropped socket, so in-flight requests can fail fast', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const closed = { count: 0 };
    await open(namespace, [], closed);

    namespace.clients[0]?.fire('close', { data: '' });

    expect(closed.count).toBe(1);
  });

  it('reports an errored socket the same way', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const closed = { count: 0 };
    await open(namespace, [], closed);

    namespace.clients[0]?.fire('error', { data: '' });

    expect(closed.count).toBe(1);
  });

  it('reports a drop only once, however many events the runtime fires', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const closed = { count: 0 };
    await open(namespace, [], closed);

    namespace.clients[0]?.fire('error', { data: '' });
    namespace.clients[0]?.fire('close', { data: '' });

    expect(closed.count).toBe(1);
  });

  it('does NOT report a drop when the caller closes deliberately', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const closed = { count: 0 };
    const inbox = await open(namespace, [], closed);

    await inbox.close();

    expect(namespace.clients[0]?.closed).toBe(true);
    // A deliberate teardown must not reject requests as though the transport
    // failed — `disconnect()` already rejects them with its own reason.
    expect(closed.count).toBe(0);
  });

  it('closes without throwing when the socket is already gone', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const inbox = await open(namespace);
    const client = namespace.clients[0];
    if (client !== undefined) {
      client.close = (): void => {
        throw new Error('already closed');
      };
    }

    await expect(inbox.close()).resolves.toBeUndefined();
  });

  it('fails by name when the namespace answers without a socket', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    namespace.omitSocket = true;

    await expect(open(namespace)).rejects.toThrow(CloudflareUnsupportedError);
    await expect(open(namespace)).rejects.toThrow('REPLY_INBOX');
  });
});
