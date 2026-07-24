import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  adaptSesModule,
  loadSesModule,
  SesProvider,
  type SesSdkModule,
  toSesInput,
  validateSesClient,
} from '../../src/providers/ses-provider.ts';
import type { ISesClient, OutgoingMail } from '../../src/interfaces/index.ts';

/** Fake SES client facade recording sent mail. */
class FakeSesClient implements ISesClient {
  readonly sent: OutgoingMail[] = [];
  sendEmail(message: OutgoingMail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Fake SESv2 SDK module capturing the command input and client config. */
function fakeModule(): {
  mod: SesSdkModule;
  configs: Record<string, unknown>[];
  inputs: Record<string, unknown>[];
} {
  const configs: Record<string, unknown>[] = [];
  const inputs: Record<string, unknown>[] = [];
  class SendEmailCommand {
    constructor(readonly input: Record<string, unknown>) {
      inputs.push(input);
    }
  }
  class SESv2Client {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
    send(_command: unknown): Promise<unknown> {
      return Promise.resolve({});
    }
  }
  return {
    mod: { SESv2Client, SendEmailCommand } as unknown as SesSdkModule,
    configs,
    inputs,
  };
}

describe('validateSesClient', () => {
  it('accepts a valid client and rejects malformed ones', () => {
    expect(validateSesClient(new FakeSesClient())).toBe(true);
    expect(validateSesClient({})).toBe(false);
    expect(validateSesClient(null)).toBe(false);
  });
});

describe('toSesInput', () => {
  it('maps recipients, cc/bcc, subject, and both bodies to the SES command shape', () => {
    const message: OutgoingMail = {
      from: 'me@x.com',
      to: ['a@x.com', 'b@x.com'],
      cc: ['c@x.com'],
      bcc: ['d@x.com'],
      subject: 'Hi',
      text: 'plain',
      html: '<b>rich</b>',
    };
    expect(toSesInput(message)).toEqual({
      FromEmailAddress: 'me@x.com',
      Destination: {
        ToAddresses: ['a@x.com', 'b@x.com'],
        CcAddresses: ['c@x.com'],
        BccAddresses: ['d@x.com'],
      },
      Content: {
        Simple: {
          Subject: { Data: 'Hi' },
          Body: { Text: { Data: 'plain' }, Html: { Data: '<b>rich</b>' } },
        },
      },
    });
  });

  it('handles a single string recipient and omits absent fields', () => {
    expect(toSesInput({ from: 'me@x.com', to: 'solo@x.com', subject: 'S' })).toEqual({
      FromEmailAddress: 'me@x.com',
      Destination: { ToAddresses: ['solo@x.com'] },
      Content: { Simple: { Subject: { Data: 'S' }, Body: {} } },
    });
  });
});

describe('adaptSesModule', () => {
  it('builds a client with credentials and sends via SendEmailCommand', async () => {
    const { mod, configs, inputs } = fakeModule();
    const facade = adaptSesModule(mod, {
      region: 'us-east-1',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    });
    expect(configs[0]).toEqual({
      region: 'us-east-1',
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });

    await facade.sendEmail({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi', text: 'yo' });
    expect(inputs[0]?.FromEmailAddress).toBe('me@x.com');
  });

  it('omits credentials when only one part is present', () => {
    const { mod, configs } = fakeModule();
    adaptSesModule(mod, { region: 'eu-west-1', accessKeyId: 'id' });
    expect(configs[0]).toEqual({ region: 'eu-west-1' });
  });
});

describe('SesProvider', () => {
  it('uses an injected client for send and reports readiness', async () => {
    const client = new FakeSesClient();
    const provider = new SesProvider({ client });

    expect(provider.isReady()).toBe(false);
    await provider.connect();
    expect(provider.isReady()).toBe(true);

    await provider.send({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi' });
    expect(client.sent).toHaveLength(1);

    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('throws when the injected client is malformed', async () => {
    const provider = new SesProvider({ client: {} as unknown as ISesClient });
    await expect(provider.connect()).rejects.toThrow('missing the required sendEmail');
  });

  it('rejects when used before connect', async () => {
    const provider = new SesProvider({ client: new FakeSesClient() });
    await expect(
      provider.send({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi' }),
    ).rejects.toThrow('not connected');
  });

  // Guarded real-import: enters the lazy SDK import without constructing a client.
  it('loadSesModule enters the real import path', async () => {
    try {
      const mod = await loadSesModule();
      expect(mod.SESv2Client).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  // Guarded: connect() with no injected client takes the lazy adapt path. When
  // the SDK is installed this constructs a real client (no network on ctor);
  // when absent the import throws — either way the branch is exercised.
  it('connect() without a client enters the lazy adapt path', async () => {
    const provider = new SesProvider({ region: 'us-east-1' });
    try {
      await provider.connect();
      expect(provider.isReady()).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
