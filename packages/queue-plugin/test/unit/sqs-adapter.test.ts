import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { adaptSqsModule, loadSqsModule } from '../../src/adapters/sqs-queue.ts';
import type { SqsSdkModule } from '../../src/adapters/sqs-queue.ts';

describe('adaptSqsModule', () => {
  function createFakeSdkModule(): SqsSdkModule & {
    commands: Array<{ name: string; input: Record<string, unknown> }>;
  } {
    const mod = {} as SqsSdkModule & {
      commands: Array<{ name: string; input: Record<string, unknown> }>;
    };
    mod.commands = [];

    mod.SQSClient = class {
      constructor(_config: Record<string, unknown>) {}
      async send(command: unknown) {
        const cmd = command as { commandName?: string; input?: Record<string, unknown> };
        mod.commands.push({
          name: cmd.commandName ?? 'unknown',
          input: cmd.input ?? {},
        });
        return { Messages: [] };
      }
      async destroy() {}
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
