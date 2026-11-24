import { describe, expect, it } from 'vitest';
import { encodeSqsEnvelope, decodeSqsEnvelope } from '../../src/adapters/sqs-envelope.ts';

const job = { id: 'j1', name: 'build', data: { secret: 'kept' }, headers: { tenant: 'a' } };
describe('SQS envelope codec', () => {
  it('round trips raw and wrapped work without imposing a producer attempt default', () => {
    const raw = encodeSqsEnvelope(job);
    const wrapped = JSON.stringify({
      Type: 'Notification',
      TopicArn: 'arn:aws:sns:us-east-1:123:jobs',
      Message: raw,
    });
    for (const body of [raw, wrapped]) {
      expect(decodeSqsEnvelope(body, 'build')).toEqual({ ok: true, envelope: { ...job, v: 1 } });
    }
    expect(JSON.parse(raw)).not.toHaveProperty('maxAttempts');
    expect(decodeSqsEnvelope(encodeSqsEnvelope({ ...job, maxAttempts: 7 }), 'build')).toMatchObject(
      { ok: true, envelope: { maxAttempts: 7 } },
    );
  });
  it.each([
    ['{', 'malformed JSON envelope'],
    ['null', 'invalid envelope object'],
    ['[]', 'invalid envelope object'],
    [JSON.stringify({ ...job, v: 2 }), 'invalid envelope version'],
    [JSON.stringify({ ...job, v: 1, id: '' }), 'invalid envelope id'],
    [JSON.stringify({ ...job, v: 1, id: 1 }), 'invalid envelope id'],
    [JSON.stringify({ ...job, v: 1, name: '' }), 'invalid envelope name'],
    [JSON.stringify({ ...job, v: 1, name: 'other' }), 'invalid envelope name'],
    [JSON.stringify({ ...job, v: 1, data: undefined }), 'invalid envelope data'],
    ...[0, -1, 1.5, null, '3'].map((maxAttempts) => [
      JSON.stringify({ ...job, v: 1, maxAttempts }),
      'invalid envelope maxAttempts',
    ]),
    [JSON.stringify({ Type: 'Notification', Message: '{}' }), 'invalid SNS notification'],
    [
      JSON.stringify({ Type: 'Notification', TopicArn: 'arn', Message: 4 }),
      'invalid SNS notification',
    ],
    [
      JSON.stringify({ Type: 'Notification', TopicArn: 'arn', Message: '{' }),
      'malformed JSON envelope',
    ],
    [JSON.stringify({ Type: 'SubscriptionConfirmation' }), 'invalid envelope version'],
  ])('refuses %s without throwing or including input', (body, reason) => {
    expect(decodeSqsEnvelope(body!, 'build')).toEqual({ ok: false, reason });
  });
  it('validates at encoding as well as decoding', () => {
    for (const maxAttempts of [NaN, Infinity, 0, -1, 1.5]) {
      expect(() => encodeSqsEnvelope({ ...job, maxAttempts })).toThrow(TypeError);
    }
    expect(() => encodeSqsEnvelope({ ...job, id: '' })).toThrow(TypeError);
  });
});
