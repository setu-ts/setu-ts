/**
 * MailPlugin — registers an {@linkcode IMailer} under `CAPABILITIES.MAIL`,
 * backed by a pluggable provider (log, SMTP, SES, SendGrid).
 *
 * @module
 */
import type { IMailer, IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { MailProvider, MailProviderOptions, MailProviderType } from '../interfaces/index.ts';
import { MailService } from '../services/mail-service.ts';
import { TemplateEngine } from '../templates/template-engine.ts';
import { LogProvider, type LogProviderOptions } from '../providers/log-provider.ts';
import { SmtpProvider } from '../providers/smtp-provider.ts';
import { SesProvider } from '../providers/ses-provider.ts';
import { SendGridProvider } from '../providers/sendgrid-provider.ts';
import type { MailPluginOptions } from '../interfaces/index.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'mail-plugin';

/** Default provider backend. */
const DEFAULT_PROVIDER: MailProviderType = 'log';

/**
 * Builds the provider adapter for the configured backend.
 *
 * @param type - The provider backend id
 * @param options - Provider-specific options
 * @param ctx - The plugin context (for `ctx.logger` on the `log` provider)
 * @returns The provider adapter
 * @throws {Error} If the provider type is unsupported
 */
export function createProvider(
  type: MailProviderType,
  options: MailProviderOptions,
  ctx: IPluginContext,
): MailProvider {
  switch (type) {
    case 'log':
      return new LogProvider(buildLogOptions(options, ctx));
    case 'smtp':
      return new SmtpProvider({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: options.auth,
        transport: options.transport,
      });
    case 'ses':
      return new SesProvider({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        client: options.client,
      });
    case 'sendgrid':
      return new SendGridProvider({
        apiKey: options.apiKey,
        endpoint: options.endpoint,
        http: options.http,
      });
    default:
      throw new Error(`Unsupported mail provider: ${type as string}`);
  }
}

/**
 * Creates the MailPlugin.
 *
 * Registers an {@linkcode IMailer} under `CAPABILITIES.MAIL`. The default
 * provider is `'log'` (zero dependency, every runtime).
 *
 * @example
 * ```typescript
 * import { MailPlugin } from '@setu-ts/mail-plugin';
 *
 * app.register(MailPlugin({
 *   provider: 'sendgrid',
 *   options: { apiKey: config.get('SENDGRID_API_KEY') },
 *   defaults: { from: 'noreply@myapp.com' },
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function MailPlugin(options?: MailPluginOptions): IPlugin {
  const providerType = options?.provider ?? DEFAULT_PROVIDER;
  const providerOptions = options?.options ?? {};

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.MAIL],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const provider = createProvider(providerType, providerOptions, ctx);
      await provider.connect();

      const templates = new TemplateEngine(options?.templates);
      const service = new MailService(provider, templates, buildServiceOptions(options));
      ctx.services.register<IMailer>(CAPABILITIES.MAIL, service);

      ctx.logger?.debug('MailPlugin registered', { provider: providerType });

      ctx.health.register(CAPABILITIES.MAIL, () =>
        Promise.resolve({
          status: provider.isReady() ? 'up' : 'down',
          data: { provider: providerType },
        }));

      ctx.lifecycle.onClose(async () => {
        await provider.disconnect();
      });
    },
  };
}

/** Builds {@linkcode LogProvider} options, threading `ctx.logger` and `sink`. */
function buildLogOptions(options: MailProviderOptions, ctx: IPluginContext): LogProviderOptions {
  const result: LogProviderOptions = {};
  if (ctx.logger !== undefined) {
    result.logger = ctx.logger;
  }
  if (options.sink !== undefined) {
    result.sink = options.sink;
  }
  return result;
}

/** Builds {@linkcode MailService} options without assigning `undefined`. */
function buildServiceOptions(options?: MailPluginOptions): { defaultFrom?: string } {
  const result: { defaultFrom?: string } = {};
  const from = options?.defaults?.from;
  if (from !== undefined) {
    result.defaultFrom = from;
  }
  return result;
}
