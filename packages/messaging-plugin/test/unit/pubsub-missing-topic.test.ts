import { describe, expect, it, vi } from 'vitest';
import {
  GcpPubSubBroker,
  PubSubTopicMissingError,
  PubSubDeadLetterTopicMissingError,
  adaptPubSubModule,
} from '../../src/index.ts';
import type { PubSubSdkModule } from '../../src/index.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { pubSubTransport, flushCloud } from '../fixtures/cloud-transports.ts';

describe('Pub/Sub missing topic', () => {
  it.each(['no-target', 'exists', 'missing', 'rejects', 'hangs', 'absent'] as const)(
    'names a create failure with target check %s',
    async (mode) => {
      const clock = clockRuntime();
      const h = pubSubTransport();
      const cause = Object.assign(new Error('NOT_FOUND'), { code: 5 });
      vi.mocked(h.transport.open).mockRejectedValue(cause);
      if (mode === 'missing') vi.mocked(h.transport.topicExists!).mockResolvedValue(false);
      if (mode === 'rejects')
        vi.mocked(h.transport.topicExists!).mockRejectedValue(new Error('admin'));
      if (mode === 'hangs')
        vi.mocked(h.transport.topicExists!).mockReturnValue(new Promise(() => {}));
      if (mode === 'absent') delete h.transport.topicExists;
      const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
        client: h.transport,
        ...(mode === 'no-target' ? {} : { deadLetterTopic: 'dead' }),
      });
      await broker.connect();
      const result = broker
        .subscribe('orders', () => {}, { queue: 'worker' })
        .catch((error: unknown) => error);
      await flushCloud();
      if (mode === 'hangs') await clock.advance(1500);
      const error = await result;
      expect(error).toBeInstanceOf(
        mode === 'missing' ? PubSubDeadLetterTopicMissingError : PubSubTopicMissingError,
      );
      expect(error).toMatchObject({ cause });
      if (mode !== 'missing')
        expect(error).toMatchObject({ topic: 'orders', subscription: 'worker' });
      if (mode === 'hangs' || mode === 'rejects' || mode === 'absent')
        expect((error as Error).message).toContain('dead-letter topic "dead" may also be missing');
      await broker.disconnect();
      expect(clock.timerCount()).toBe(0);
    },
  );
  it('preserves other gRPC failures', async () => {
    const h = pubSubTransport();
    const error = { code: 7 };
    vi.mocked(h.transport.open).mockRejectedValue(error);
    const broker = new GcpPubSubBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: h.transport,
    });
    await broker.connect();
    await expect(broker.subscribe('orders', () => {})).rejects.toBe(error);
    await broker.disconnect();
  });
  it('uses bounded getMetadata instead of exists and preserves non-not-found failures', async () => {
    const getMetadata = vi.fn(() => Promise.resolve([]));
    const mod = {
      PubSub: class {
        topic() {
          return { getMetadata };
        }
      },
    } as unknown as PubSubSdkModule;
    const transport = adaptPubSubModule(mod, { projectId: 'p' });
    expect(await transport.topicExists!('orders')).toBe(true);
    expect(getMetadata).toHaveBeenCalledWith({ timeout: 1500, retry: null });
    getMetadata.mockRejectedValueOnce({ code: 5 });
    expect(await transport.topicExists!('orders')).toBe(false);
    const refused = { code: 7 };
    getMetadata.mockRejectedValueOnce(refused);
    await expect(transport.topicExists!('orders')).rejects.toBe(refused);
    const missing = adaptPubSubModule(
      {
        PubSub: class {
          topic() {
            return {};
          }
        },
      } as unknown as PubSubSdkModule,
      { projectId: 'p' },
    );
    await expect(missing.topicExists!('orders')).rejects.toThrow('getMetadata is unavailable');
  });
});
