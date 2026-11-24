import { describe, expect, it } from 'vitest';
import { adaptSqsModule, loadSqsModule } from '../../src/adapters/sqs-queue.ts';
import type { SqsSdkModule } from '../../src/adapters/sqs-queue.ts';

describe('adaptSqsModule', () => {
  it('maps attributes, policy reads, URL resolution and source message ids through SDK commands', async () => {
    const commands: Record<string, unknown>[] = [];
    let response: unknown = {};
    const command = (name: string) =>
      class {
        readonly name = name;
        constructor(readonly input: Record<string, unknown>) {}
      };
    const sdk: SqsSdkModule = {
      SQSClient: class {
        send(command: unknown): Promise<unknown> {
          commands.push(command as Record<string, unknown>);
          return Promise.resolve(response);
        }
        destroy(): Promise<void> {
          return Promise.resolve();
        }
      },
      SendMessageCommand: command('SendMessageCommand'),
      ReceiveMessageCommand: command('ReceiveMessageCommand'),
      ChangeMessageVisibilityCommand: command('ChangeMessageVisibilityCommand'),
      DeleteMessageCommand: command('DeleteMessageCommand'),
      GetQueueAttributesCommand: command('GetQueueAttributesCommand'),
      GetQueueUrlCommand: command('GetQueueUrlCommand'),
    };
    const transport = adaptSqsModule(sdk, {});
    const attributes = { reason: { DataType: 'String' as const, StringValue: 'unreadable' } };
    await transport.send('dead', 'body', undefined, attributes);
    expect(commands.at(-1)).toEqual({
      name: 'SendMessageCommand',
      input: { QueueUrl: 'dead', MessageBody: 'body', MessageAttributes: attributes },
    });
    response = { Attributes: { RedrivePolicy: 'policy' } };
    expect(await transport.getQueueAttributes!('source', ['RedrivePolicy'])).toEqual({
      RedrivePolicy: 'policy',
    });
    expect(commands.at(-1)).toEqual({
      name: 'GetQueueAttributesCommand',
      input: { QueueUrl: 'source', AttributeNames: ['RedrivePolicy'] },
    });
    response = {};
    expect(await transport.getQueueAttributes!('source', ['RedrivePolicy'])).toEqual({});
    await expect(transport.getQueueUrl!('dead', '123')).rejects.toThrow('no QueueUrl');
    response = { QueueUrl: 'resolved' };
    expect(await transport.getQueueUrl!('dead', '123')).toBe('resolved');
    expect(commands.at(-1)).toEqual({
      name: 'GetQueueUrlCommand',
      input: { QueueName: 'dead', QueueOwnerAWSAccountId: '123' },
    });
    response = {
      Messages: [
        {
          MessageId: 'mid',
          Body: 'body',
          ReceiptHandle: 'receipt',
          Attributes: { ApproximateReceiveCount: '2' },
        },
      ],
    };
    expect(await transport.receive('source', 1, 30)).toEqual([
      { messageId: 'mid', body: 'body', receiptHandle: 'receipt', approximateReceiveCount: '2' },
    ]);
    expect(commands.at(-1)).toMatchObject({
      name: 'ReceiveMessageCommand',
      input: { QueueUrl: 'source' },
    });
    await transport.close();
  });
  function createFakeSdkModule(): SqsSdkModule & {
    commands: Array<{ name: string; input: Record<string, unknown> }>;
  } {
    const mod = {} as SqsSdkModule & {
      commands: Array<{ name: string; input: Record<string, unknown> }>;
    };
    mod.commands = [];

    mod.SQSClient = class {
      constructor(_config: Record<string, unknown>) {}
      send(command: unknown) {
        const cmd = command as { commandName?: string; input?: Record<string, unknown> };
        mod.commands.push({
          name: cmd.commandName ?? 'unknown',
          input: cmd.input ?? {},
        });
        return Promise.resolve({ Messages: [] });
      }
      destroy() {
        return Promise.resolve();
      }
    };

    mod.SendMessageCommand = class {
      constructor(input: Record<string, unknown>) {
        Object.defineProperty(this, 'commandName', { value: 'SendMessage' });
        Object.defineProperty(this, 'input', { value: input });
      }
    };

    mod.ReceiveMessageCommand = class {
      constructor(input: Record<string, unknown>) {
        Object.defineProperty(this, 'commandName', { value: 'ReceiveMessage' });
        Object.defineProperty(this, 'input', { value: input });
      }
    };

    mod.DeleteMessageCommand = class {
      constructor(input: Record<string, unknown>) {
        Object.defineProperty(this, 'commandName', { value: 'DeleteMessage' });
        Object.defineProperty(this, 'input', { value: input });
      }
    };

    mod.ChangeMessageVisibilityCommand = class {
      constructor(input: Record<string, unknown>) {
        Object.defineProperty(this, 'commandName', { value: 'ChangeMessageVisibility' });
        Object.defineProperty(this, 'input', { value: input });
      }
    };

    for (const name of ['GetQueueAttributesCommand', 'GetQueueUrlCommand'] as const) {
      mod[name] = class {
        constructor(input: Record<string, unknown>) {
          Object.defineProperty(this, 'commandName', { value: name.replace('Command', '') });
          Object.defineProperty(this, 'input', { value: input });
        }
      };
    }
    return mod;
  }

  it('constructs SendMessageCommand', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptSqsModule(sdk, {});

    await transport.send('https://sqs.queue', 'body');

    const cmd = sdk.commands.find((c) => c.name === 'SendMessage');
    expect(cmd).toBeDefined();
    expect(cmd!.input.QueueUrl).toBe('https://sqs.queue');
    expect(cmd!.input.MessageBody).toBe('body');
  });

  it('includes DelaySeconds when provided', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptSqsModule(sdk, {});

    await transport.send('https://sqs.queue', 'body', 10);

    const cmd = sdk.commands.find((c) => c.name === 'SendMessage');
    expect(cmd!.input.DelaySeconds).toBe(10);
  });

  it('uses MessageSystemAttributeNames', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptSqsModule(sdk, {});

    await transport.receive('https://sqs.queue', 10, 30);

    const cmd = sdk.commands.find((c) => c.name === 'ReceiveMessage');
    expect(cmd).toBeDefined();
    expect(cmd!.input.MessageSystemAttributeNames).toContain('ApproximateReceiveCount');
  });

  it('constructs DeleteMessageCommand', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptSqsModule(sdk, {});

    await transport.delete('https://sqs.queue', 'handle');

    const cmd = sdk.commands.find((c) => c.name === 'DeleteMessage');
    expect(cmd!.input.ReceiptHandle).toBe('handle');
  });

  it('constructs ChangeMessageVisibilityCommand', async () => {
    const sdk = createFakeSdkModule();
    const transport = adaptSqsModule(sdk, {});

    await transport.changeVisibility('https://sqs.queue', 'handle', 60);

    const cmd = sdk.commands.find((c) => c.name === 'ChangeMessageVisibility');
    expect(cmd!.input.VisibilityTimeout).toBe(60);
  });

  it('exports loadSqsModule', () => {
    expect(typeof loadSqsModule).toBe('function');
  });
});
