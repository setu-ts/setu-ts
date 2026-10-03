/**
 * MailPlugin — registers an {@linkcode IMailer} under `CAPABILITIES.MAIL`,
 * backed by a pluggable provider (log, SMTP, SES, SendGrid).
 *
 * @module
 */
import type {
  HealthCheckResult,
  IMailer,
  IPlugin,
  IPluginContext,
  IViewEngine,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY, resolveProbeTiming } from '@setu-ts/common';
import type {
  MailProvider,
  MailProviderOptions,
  MailProviderType,
  MailTemplate,
} from '../interfaces/index.ts';
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
    // The VIEW edge is what makes the `register()`-time engine lookup a
    // contract rather than plugin-order luck: the resolver orders an optional
    // dependency first (`plugin-resolver.ts`), and `view-plugin` declares no
    // edge of its own, so this cannot form a cycle (the M90i P1 class).
    optionalDependencies: [CAPABILITIES.LOGGER, CAPABILITIES.VIEW],
    provides: [CAPABILITIES.MAIL],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const provider = createProvider(providerType, providerOptions, ctx);
      await provider.connect();

      // Resolved once, here, so a component template with no provider fails
      // at startup naming both remedies (inside the TemplateEngine constructor)
      // rather than on the first `sendTemplate` of a shipped path.
      const templates = new TemplateEngine(
        options?.templates,
        resolveViewEngine(ctx, options?.templates),
      );
      // The runtime's clock and timers reach the service, which is where the
      // reachability probe is cached and bounded: this indicator and every
      // email channel in `notification-plugin` ask the same question, and the
      // cache has to sit where they meet or each caller hits the transport.
      const service = new MailService(provider, templates, {
        ...buildServiceOptions(options),
        probeTiming: resolveProbeTiming(ctx.runtime),
      });
      ctx.services.register<IMailer>(CAPABILITIES.MAIL, service);

      ctx.logger?.debug('MailPlugin registered', { provider: providerType });

      // M70c: reports BOTH signals. `isReady()` is lifecycle (never started /
      // shut down → `down`); `isHealthy()` is reachability (the mail backend
      // answers right now). A ready-but-unreachable provider is `down` with
      // `data.reachable: false`. A provider that cannot probe (smtp/SES client
      // without the optional member) is `up` with `data.reachable: 'unknown'`.
      //
      // Reachability is read through the SERVICE, not past it to the provider.
      // `IMailer.isHealthy` is now public, so a holder of the capability —
      // `notification-plugin`'s email channel — asks the same question this
      // indicator does; routing both through `MailService.isHealthy` is what
      // stops the two answers drifting.
      const mailIndicator = async (): Promise<HealthCheckResult> => {
        if (!provider.isReady()) {
          return { status: 'down', data: { provider: providerType, reachable: false } };
        }
        const reachable = await service.isHealthy();
        if (reachable === undefined) {
          return { status: 'up', data: { provider: providerType, reachable: 'unknown' } };
        }
        if (reachable === false) {
          return { status: 'down', data: { provider: providerType, reachable: false } };
        }
        return { status: 'up', data: { provider: providerType, reachable: true } };
      };
      ctx.health.register(CAPABILITIES.MAIL, mailIndicator);

      ctx.lifecycle.onClose(async () => {
        await provider.disconnect();
      });
    },
  };
}

/**
 * Resolves the view engine the component-template arm renders through, or
 * `undefined` when no configured template needs one.
 *
 * Only the registry is consulted. A container-supplied engine
 * (`@Injectable({ token: CAPABILITIES.VIEW })` under `DiPlugin`) is registered
 * into `ctx.container` during `DecoratorPlugin`'s OWN `register()`, which runs
 * after this one, so there is nothing to find there at this point; the
 * refusal names the registry remedy. An application with only string
 * templates performs no lookup at all, so it needs no view plugin.
 *
 * @param ctx - The plugin context
 * @param templates - The configured template map
 * @returns The engine, or `undefined` when no component template is configured
 *   or no provider is registered (the constructor then refuses by name)
 */
function resolveViewEngine(
  ctx: IPluginContext,
  templates: Readonly<Record<string, MailTemplate>> | undefined,
): IViewEngine | undefined {
  const needsEngine = Object.values(templates ?? {}).some((t) =>
    'view' in t && t.view !== undefined
  );
  if (!needsEngine || !ctx.services.has(CAPABILITIES.VIEW)) {
    return undefined;
  }
  return ctx.services.get<IViewEngine>(CAPABILITIES.VIEW);
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
