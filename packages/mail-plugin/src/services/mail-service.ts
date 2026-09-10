/**
 * MailService — the {@linkcode IMailer} implementation registered under
 * `CAPABILITIES.MAIL`. Resolves the sender once, renders templates through the
 * {@linkcode TemplateEngine}, and dispatches to a {@linkcode MailProvider}.
 *
 * @module
 */
import {
  createCachedProbe,
  type IMailer,
  type MailMessage,
  type ProbeTiming,
} from '@setu-ts/common';
import type { MailProvider, OutgoingMail } from '../interfaces/index.ts';
import type { TemplateEngine } from '../templates/template-engine.ts';

/**
 * Options for {@linkcode MailService}.
 *
 * @since 0.1.0
 */
export interface MailServiceOptions {
  /** Default sender used when a message omits `from`. */
  defaultFrom?: string;
  /**
   * Monotonic clock and timers used to cache and bound
   * {@linkcode MailService.isHealthy}.
   *
   * Supplied by `MailPlugin` from `ctx.runtime`. When omitted the probe is
   * delegated straight through, uncached and unbounded, because there is no
   * clock this package may lawfully read without one (AI_GUIDELINES §4.1).
   *
   * @since 0.6.0
   */
  probeTiming?: ProbeTiming;
}

/** Reachability outcome cache lifetime, in milliseconds. */
const PROBE_TTL_MS = 5000;

/** Per-probe timeout, in milliseconds. A slower probe counts as unreachable. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Mailer backed by a pluggable provider and a template engine.
 *
 * `send` and `sendTemplate` both funnel through the single {@link MailService.send}
 * path, so the default-`from` resolution and provider dispatch live in one place.
 *
 * @since 0.1.0
 */
export class MailService implements IMailer {
  readonly #provider: MailProvider;
  readonly #templates: TemplateEngine;
  readonly #defaultFrom: string | undefined;
  readonly #probe: (() => Promise<boolean>) | undefined;

  /**
   * @param provider - The backing provider adapter
   * @param templates - The template engine (built from plugin options)
   * @param options - Default sender
   */
  constructor(provider: MailProvider, templates: TemplateEngine, options?: MailServiceOptions) {
    this.#provider = provider;
    this.#templates = templates;
    this.#defaultFrom = options?.defaultFrom;
    this.#probe = buildProbe(provider, options?.probeTiming);
  }

  /**
   * Sends an email, resolving `from` from the message or the configured default.
   *
   * @param message - The message to send
   * @throws {Error} If no `from` can be resolved, or the provider rejects it
   */
  async send(message: MailMessage): Promise<void> {
    await this.#provider.send(this.#resolve(message));
  }

  /**
   * Renders a named template and sends the result. The `subject` is taken
   * verbatim from `message`; the template supplies the `html`/`text` bodies.
   *
   * @param template - Template name
   * @param message - Envelope (recipients, subject, optional `from`/`cc`/`bcc`)
   * @param data - Template variables
   * @throws {Error} If the template is unknown, a variable is missing, no `from`
   *   can be resolved, or the provider rejects the message
   */
  async sendTemplate(
    template: string,
    message: Omit<MailMessage, 'html' | 'text'>,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const rendered = this.#templates.render(template, data);
    await this.#provider.send(this.#resolve({ ...message, ...rendered }));
  }

  /**
   * Reports whether the backing provider's transport is reachable right now.
   *
   * Delegates to the provider's own optional probe, which is the single
   * implementation of this question in the package — `MailPlugin`'s health
   * indicator reads it through here rather than reaching past the service, so
   * the capability and the indicator cannot disagree about what `reachable`
   * means (the one-capability-one-implementation rule).
   *
   * The cache lives HERE, at the capability boundary, rather than in each
   * caller. Two independent callers ask this question on one aggregate health
   * check — the `mail` indicator, and `notification-plugin`'s email channel
   * once per configured alias — so a cache per caller would still hit the
   * transport once per caller, which is what the caching exists to prevent.
   * Cached here they coalesce into one call however many aliases are
   * configured. The probe is bounded too, so a transport that stops answering
   * cannot hold the health endpoint open; a probe that exceeds the bound or
   * rejects resolves `false` — it was reached for and did not answer, which is
   * a different fact from `undefined`, where it could not be asked.
   *
   * @returns `true` reachable, `false` contacted and unreachable, `undefined`
   * when the configured provider exposes no side-effect-free probe
   * @since 0.6.0
   */
  isHealthy(): Promise<boolean | undefined> {
    // No probe on the provider means the question cannot be asked at all.
    // `SesProvider` and `SmtpProvider` DELETE theirs when the injected client
    // or transport exposes no side-effect-free probe (no `isHealthy` on the
    // SES client, no `verify()` on the SMTP transport), which is the case this
    // arm exists for. Every provider that ships a probe answers concretely:
    // `LogProvider` is always `true` (it touches no network) and
    // `SendGridProvider` calls the scopes endpoint.
    if (this.#probe === undefined) {
      return Promise.resolve(undefined);
    }
    return this.#probe();
  }

  /** Resolves `from` and asserts a sender is present. */
  #resolve(message: MailMessage): OutgoingMail {
    const from = message.from ?? this.#defaultFrom;
    if (from === undefined) {
      throw new Error('MailMessage requires a "from" address or a configured default');
    }
    return { ...message, from };
  }
}

/**
 * Builds the cached, bounded reachability probe, or `undefined` when there is
 * nothing to probe.
 *
 * Returns `undefined` in two distinct cases that the caller treats alike: the
 * provider exposes no probe, and no {@linkcode ProbeTiming} was injected. The
 * second is not a silent degradation to an ambient clock — outside
 * `packages/runtime` there is none to read — so an unbounded, uncached
 * delegation is what an uninjected `MailService` gets.
 *
 * @param provider - The backing provider
 * @param timing - Runtime clock and timers, when the caller has them
 * @returns The probe, or `undefined` when none can be built
 */
function buildProbe(
  provider: MailProvider,
  timing: ProbeTiming | undefined,
): (() => Promise<boolean>) | undefined {
  const isHealthy = provider.isHealthy;
  if (typeof isHealthy !== 'function') {
    return undefined;
  }
  // Bound call: a provider's probe reads its own transport, so it must be
  // invoked on its owner.
  const bound = (): Promise<boolean> => isHealthy.call(provider);
  if (timing === undefined) {
    return bound;
  }
  return createCachedProbe({
    probe: bound,
    ttlMs: PROBE_TTL_MS,
    timeoutMs: PROBE_TIMEOUT_MS,
    hrtime: timing.hrtime,
    setTimer: timing.setTimer,
    clearTimer: timing.clearTimer,
  });
}
