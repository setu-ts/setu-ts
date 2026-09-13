/**
 * `onIntegrationEvent` — the returned `SubscriptionDefinition` shape, and the
 * wrapper driven directly: parse success, the coercing-parser
 * `envelope.data === payload` reference rule, and one case per rejection
 * reason (structured fields AND a message-only read, since the default
 * in-memory composition flattens rejections to `error.message`).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MessageMetadata } from '@setu-ts/common';

import { IntegrationEventRejectedError } from '../../../src/errors.ts';
import { defineIntegrationEvent } from '../../../src/integration/definition.ts';
import { onIntegrationEvent } from '../../../src/integration/subscribe.ts';
// Declared against the BARREL: dropping the types from `src/index.ts` must
// fail this file's type-check (the M56 defect class).
import type { IntegrationEventHandler } from '../../../src/index.ts';

const FIXED_MS = 1_700_000_000_000;

const definition = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1',
  parse: (value) => value as { orderId: string },
});

const METADATA: MessageMetadata = { topic: 'orders.placed.v1', messageId: 'm-1' };

const VALID_ENVELOPE = {
  id: 'e-1',
  type: 'orders.placed',
  version: 1,
  occurredAt: new Date(FIXED_MS).toISOString(),
  data: { orderId: 'o-1' },
};

/** Drives the returned handler and captures the rejection it throws. */
async function catchRejection(
  handler: (raw: unknown, metadata: MessageMetadata) => void | Promise<void>,
  raw: unknown,
): Promise<unknown> {
  try {
    await handler(raw, METADATA);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('onIntegrationEvent — returned definition', () => {
  it('carries the definition topic and forwards subscribe options unchanged', () => {
    let calls = 0;
    const handler: IntegrationEventHandler<{ orderId: string }> = () => {
      calls++;
    };
    const withOptions = onIntegrationEvent(definition, handler, { queue: 'billing' });
    expect(withOptions.topic).toBe('orders.placed.v1');
    expect(withOptions.options).toEqual({ queue: 'billing' });

    const withoutOptions = onIntegrationEvent(definition, handler);
    expect(withoutOptions.topic).toBe('orders.placed.v1');
    expect('options' in withoutOptions).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('onIntegrationEvent — delivery', () => {
  it('invokes the handler once with the parsed payload, the envelope, and the metadata', async () => {
    // A COERCING parser: it returns a new object, which is exactly why the
    // envelope handed to the handler must be rebuilt from the parsed value.
    const coercing = defineIntegrationEvent<{ orderId: string; observedAt: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: (value) => {
        const raw = value as { orderId: string };
        return { orderId: raw.orderId.toUpperCase(), observedAt: 'parsed' };
      },
    });
    let calls = 0;
    let seenPayload: unknown;
    let seenEnvelope: unknown;
    let seenMetadata: unknown;
    const handler: IntegrationEventHandler<{ orderId: string; observedAt: string }> = (
      payload,
      envelope,
      metadata,
    ) => {
      calls++;
      seenPayload = payload;
      seenEnvelope = envelope;
      seenMetadata = metadata;
    };

    const returned = onIntegrationEvent(coercing, handler);
    await returned.handler({ ...VALID_ENVELOPE }, METADATA);

    expect(calls).toBe(1);
    const payload = seenPayload as { orderId: string; observedAt: string };
    const envelope = seenEnvelope as { data: unknown; id: string; type: string; version: number };
    expect(payload.orderId).toBe('O-1');
    expect(payload.observedAt).toBe('parsed');
    // §3.6: `envelope.data === payload` holds by REFERENCE for every delivery.
    expect(envelope.data).toBe(payload);
    expect(envelope.id).toBe('e-1');
    expect(envelope.type).toBe('orders.placed');
    expect(envelope.version).toBe(1);
    expect(seenMetadata).toBe(METADATA);
  });
});

describe('onIntegrationEvent — rejections (structured fields, handler never invoked)', () => {
  it('refuses a malformed envelope with reason malformed', async () => {
    let calls = 0;
    const returned = onIntegrationEvent(definition, () => {
      calls++;
    });
    const caught = await catchRejection(returned.handler, 42);
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    const rejection = caught as IntegrationEventRejectedError;
    expect(rejection.reason).toBe('malformed');
    expect(rejection.topic).toBe('orders.placed.v1');
    expect(rejection.expectedType).toBe('orders.placed');
    expect(rejection.expectedVersion).toBe(1);
    expect(calls).toBe(0);
  });

  it('refuses a mistyped mandatory field with reason malformed', async () => {
    let calls = 0;
    const returned = onIntegrationEvent(definition, () => {
      calls++;
    });
    const caught = await catchRejection(returned.handler, { ...VALID_ENVELOPE, id: 42 });
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    expect((caught as IntegrationEventRejectedError).reason).toBe('malformed');
    expect(calls).toBe(0);
  });

  it('refuses a foreign type with reason type-mismatch', async () => {
    let calls = 0;
    const returned = onIntegrationEvent(definition, () => {
      calls++;
    });
    const caught = await catchRejection(returned.handler, {
      ...VALID_ENVELOPE,
      type: 'orders.cancelled',
    });
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    expect((caught as IntegrationEventRejectedError).reason).toBe('type-mismatch');
    expect(calls).toBe(0);
  });

  it('refuses a foreign version with reason version-mismatch', async () => {
    let calls = 0;
    const returned = onIntegrationEvent(definition, () => {
      calls++;
    });
    const caught = await catchRejection(returned.handler, { ...VALID_ENVELOPE, version: 2 });
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    expect((caught as IntegrationEventRejectedError).reason).toBe('version-mismatch');
    expect(calls).toBe(0);
  });

  it('carries the parser error as cause with reason parse', async () => {
    let calls = 0;
    const parserError = new Error('orderId: expected string');
    const failing = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: () => {
        throw parserError;
      },
    });
    const returned = onIntegrationEvent(failing, () => {
      calls++;
    });
    const caught = await catchRejection(returned.handler, { ...VALID_ENVELOPE });
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    const rejection = caught as IntegrationEventRejectedError;
    expect(rejection.reason).toBe('parse');
    expect(rejection.cause).toBe(parserError);
    expect(calls).toBe(0);
  });

  it('carries a non-Error parser throw verbatim as cause', async () => {
    const failing = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: () => {
        throw 'not an Error';
      },
    });
    const returned = onIntegrationEvent(failing, () => {});
    const caught = await catchRejection(returned.handler, { ...VALID_ENVELOPE });
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    expect((caught as IntegrationEventRejectedError).cause).toBe('not an Error');
  });
});

describe('onIntegrationEvent — the message carries the whole diagnostic', () => {
  // One case per reason, read through `message` ONLY: the default in-memory
  // composition's reporter flattens a rejection to `error.message`, so on
  // that path the message must name the reason and the topic without any
  // structured field being read.
  async function messageOf(raw: unknown): Promise<string> {
    const failing = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: () => {
        throw new Error('orderId: expected string');
      },
    });
    const returned = onIntegrationEvent(failing, () => {});
    const caught = await catchRejection(returned.handler, raw);
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    return (caught as IntegrationEventRejectedError).message;
  }

  it('the malformed message names the reason and the topic', async () => {
    const message = await messageOf(null);
    expect(message).toContain('malformed');
    expect(message).toContain('orders.placed.v1');
  });

  it('the type-mismatch message names the reason and the topic', async () => {
    const message = await messageOf({ ...VALID_ENVELOPE, type: 'other.event' });
    expect(message).toContain('type-mismatch');
    expect(message).toContain('orders.placed.v1');
    expect(message).toContain('other.event');
  });

  it('the version-mismatch message names the reason and the topic', async () => {
    const message = await messageOf({ ...VALID_ENVELOPE, version: 7 });
    expect(message).toContain('version-mismatch');
    expect(message).toContain('orders.placed.v1');
  });

  it('the parse message names the reason, the topic, and the parser detail', async () => {
    const message = await messageOf({ ...VALID_ENVELOPE });
    expect(message).toContain('parse');
    expect(message).toContain('orders.placed.v1');
    expect(message).toContain('orderId: expected string');
  });
});
