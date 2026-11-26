import { describe, expect, it, vi } from 'vitest';
import { realFanOutPair } from '../fixtures/real-fan-out.ts';

const mocks = vi.hoisted(() => ({ rabbitConnect: vi.fn(), natsConnect: vi.fn() }));
vi.mock('amqplib', () => ({ connect: mocks.rabbitConnect }));
vi.mock('nats', () => ({ connect: mocks.natsConnect }));

describe('Real fan-out fixture setup cleanup', () => {
  it('closes RabbitMQ admin when channel creation fails', async () => {
    const cause = new Error('channel');
    const close = vi.fn(() => Promise.resolve());
    mocks.rabbitConnect.mockResolvedValue({ createChannel: () => Promise.reject(cause), close });
    await expect(realFanOutPair('rabbitmq')).rejects.toBe(cause);
    expect(close).toHaveBeenCalledOnce();
  });
  it('closes the RabbitMQ channel and admin when a later client fails', async () => {
    const cause = new Error('client');
    const close = vi.fn(() => Promise.resolve());
    const channelClose = vi.fn(() => Promise.resolve());
    mocks.rabbitConnect
      .mockResolvedValueOnce({
        createChannel: () => Promise.resolve({ close: channelClose }),
        close,
      })
      .mockRejectedValueOnce(cause);
    await expect(realFanOutPair('rabbitmq')).rejects.toBe(cause);
    expect(close).toHaveBeenCalledOnce();
    expect(channelClose).toHaveBeenCalledOnce();
  });
  it('closes NATS admin when manager setup fails', async () => {
    const cause = new Error('manager');
    const close = vi.fn(() => Promise.resolve());
    mocks.natsConnect.mockResolvedValue({ jetstreamManager: () => Promise.reject(cause), close });
    await expect(realFanOutPair('nats')).rejects.toBe(cause);
    expect(close).toHaveBeenCalledOnce();
  });
});
