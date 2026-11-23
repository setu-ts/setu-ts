/**
 * SmtpProvider — sends over SMTP via `nodemailer`. The package is never a hard
 * dependency: inject an {@linkcode ISmtpTransport}, or the provider lazily
 * imports `nodemailer` and adapts its transporter. Requires raw sockets, so it
 * is Node/Deno/Bun only (not Cloudflare Workers).
 *
 * @module
 */
import type { DeadlineOptions, IDnsResolver } from '@setu-ts/common';
import { OptionalDependencyUnavailableError, withDeadline } from '@setu-ts/common';
import type { ISmtpTransport, MailProvider, OutgoingMail } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';
import { toBase64 } from './encoding.ts';

/** Methods an injected transport facade must expose. */
const REQUIRED_METHODS = ['sendMail'] as const;

/** Default SMTP submission port. */
const DEFAULT_PORT = 587;

/** The subset of `nodemailer` the adapter uses. */
export interface NodemailerModule {
  createTransport: (options: Record<string, unknown>) => ISmtpTransport;
}

/**
 * Options for {@linkcode SmtpProvider}.
 *
 * @since 0.1.0
 */
export interface SmtpProviderOptions {
  /** SMTP server host. */
  host?: string | undefined;
  /** SMTP server port. Default `587`. */
  port?: number | undefined;
  /** Use an implicit TLS connection. Default `false`. */
  secure?: boolean | undefined;
  /** SMTP auth credentials. */
  auth?: { user: string; pass: string } | undefined;
  /** Injected transport facade; bypasses the lazy `nodemailer` import. */
  transport?: ISmtpTransport | undefined;
  /**
   * How long to wait for the TCP connection, in milliseconds (nodemailer
   * `connectionTimeout`). Also bounds each DNS refresh under `dnsTtlMs`.
   * nodemailer's default (120000 ms) applies when absent.
   *
   * @since 0.14.0
   */
  connectionTimeoutMs?: number | undefined;
  /**
   * How long to wait for the server's greeting, in milliseconds (nodemailer
   * `greetingTimeout`).
   *
   * @since 0.14.0
   */
  greetingTimeoutMs?: number | undefined;
  /**
   * How long an idle connection may stay silent, in milliseconds (nodemailer
   * `socketTimeout`).
   *
   * @since 0.14.0
   */
  socketTimeoutMs?: number | undefined;
  /**
   * Re-resolve `host` through the runtime's DNS at most this often, in
   * milliseconds, and connect to the address found, presenting and verifying
   * `host` as the TLS server name. Absent: nodemailer resolves `host` itself
   * and caches the answer for 5 minutes. Refused with an injected `transport`,
   * and on a runtime without DNS.
   *
   * @since 0.14.0
   */
  dnsTtlMs?: number | undefined;
}

/** What `SmtpProvider` needs from the runtime for `dnsTtlMs`. */
export interface SmtpRuntime {
  /** The runtime's resolver (`IRuntimeServices.dns`). */
  readonly dns?: IDnsResolver | undefined;
  /** Monotonic clock in milliseconds (`IRuntimeServices.hrtime`). */
  readonly hrtime: () => number;
  /** Runtime timers for bounding DNS refreshes; ambient timers when absent. */
  readonly timing?: DeadlineOptions['timing'];
}

/**
 * Validates that an injected object matches {@linkcode ISmtpTransport}.
 *
 * @param transport - The candidate transport
 * @returns `true` when the shape is valid
 */
export function validateSmtpTransport(transport: unknown): transport is ISmtpTransport {
  return hasMethods(transport, REQUIRED_METHODS);
}

/**
 * Adapts the `nodemailer` module to a transport facade. Pure — unit-tested with
 * a fake module; the real module is supplied on the lazy path by
 * {@linkcode loadNodemailerModule}.
 *
 * @param mod - The `nodemailer` module (real or fake)
 * @param options - SMTP connection options
 * @param address - The address to connect to instead of `options.host` (the
 *   provider's `dnsTtlMs` resolution); `options.host` stays the TLS server name
 * @returns The transport facade
 */
export function adaptNodemailerModule(
  mod: NodemailerModule,
  options: SmtpProviderOptions,
  address?: string,
): ISmtpTransport {
  return mod.createTransport(buildTransportConfig(options, address));
}

/**
 * Lazily imports `nodemailer`. Only exercised on the lazy path.
 *
 * @returns The `nodemailer` module
 * @throws {Error} If `nodemailer` cannot be resolved
 */
export async function loadNodemailerModule(): Promise<NodemailerModule> {
  try {
    return (await import('nodemailer')) as unknown as NodemailerModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('nodemailer', {
      requiredBy: '@setu-ts/mail-plugin',
      cause: error,
    });
  }
}

/**
 * Builds a transport config without assigning `undefined` to optional fields.
 * With `address`, the transport connects to that address and presents `host`
 * as the TLS server name, so the certificate is still checked against `host`.
 */
export function buildTransportConfig(
  options: SmtpProviderOptions,
  address?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    port: options.port ?? DEFAULT_PORT,
    secure: options.secure ?? false,
  };
  if (address !== undefined) {
    config.host = address;
    config.tls = { servername: options.host };
  } else if (options.host !== undefined) {
    config.host = options.host;
  }
  if (options.auth !== undefined) {
    config.auth = options.auth;
  }
  if (options.connectionTimeoutMs !== undefined) {
    config.connectionTimeout = options.connectionTimeoutMs;
  }
  if (options.greetingTimeoutMs !== undefined) {
    config.greetingTimeout = options.greetingTimeoutMs;
  }
  if (options.socketTimeoutMs !== undefined) {
    config.socketTimeout = options.socketTimeoutMs;
  }
  return config;
}

/** The largest delay a runtime timer accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/** The refusal for a call on a provider that is not connected. */
function notConnected(): Error {
  return new Error('SmtpProvider is not connected');
}

/** Reports whether a host is an IP literal (no DNS to re-resolve). */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** Maps an {@linkcode OutgoingMail} to nodemailer's message fields. */
export function toNodemailerMessage(
  message: OutgoingMail,
): Parameters<ISmtpTransport['sendMail']>[0] {
  const mail: Parameters<ISmtpTransport['sendMail']>[0] = {
    from: message.from,
    to: joinAddresses(message.to),
    subject: message.subject,
  };
  if (message.text !== undefined) {
    mail.text = message.text;
  }
  if (message.html !== undefined) {
    mail.html = message.html;
  }
  if (message.cc !== undefined) {
    mail.cc = message.cc.join(', ');
  }
  if (message.bcc !== undefined) {
    mail.bcc = message.bcc.join(', ');
  }
  if (message.attachments !== undefined) {
    mail.attachments = message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: toBase64(attachment.content),
      encoding: 'base64',
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      // A `contentId` attachment is referenced from the body (`cid:`), so it
      // goes out inline; nodemailer would only infer that for an image.
      ...(attachment.contentId === undefined
        ? {}
        : { cid: attachment.contentId, contentDisposition: 'inline' as const }),
    }));
  }
  return mail;
}

/** Joins one-or-many addresses into a comma-separated header value. */
function joinAddresses(to: string | readonly string[]): string {
  return Array.isArray(to) ? to.join(', ') : (to as string);
}

/**
 * SMTP provider over `nodemailer`.
 *
 * @since 0.1.0
 */
export class SmtpProvider implements MailProvider {
  #transport: ISmtpTransport | null = null;
  readonly #options: SmtpProviderOptions;
  readonly #runtime: SmtpRuntime | undefined;
  /** The module, kept so `dnsTtlMs` can build a transport for a new address. */
  #module: NodemailerModule | null = null;
  /** The address the current transport connects to, under `dnsTtlMs`. */
  #address: string | undefined;
  /** Last DNS attempt (including failed/empty lookups), monotonic ms. */
  #triedAt = Number.NEGATIVE_INFINITY;
  /** A generation shares one lookup, including with concurrent sends. */
  #refresh: { generation: number; promise: Promise<ISmtpTransport> } | null = null;
  readonly #users = new Map<ISmtpTransport, number>();
  readonly #retired = new Set<ISmtpTransport>();
  readonly #closed = new WeakSet<ISmtpTransport>();
  /** Bumped by `disconnect()`, so a refresh still in flight cannot reconnect. */
  #generation = 0;
  /**
   * M70c: present only when the transport exposes `verify()`; its absence is
   * *unknown* reachability, not `false` (a minimal injected fake has not told
   * us the server is dead).
   *
   * @since 0.1.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - SMTP connection/injection options
   * @param runtime - The runtime's resolver and clock, read only for
   *   `dnsTtlMs`; `MailPlugin` supplies them
   * @throws {Error} When `dnsTtlMs` is set with an injected transport, without
   *   a `host`, or without a runtime resolver
   * @throws {RangeError} When `dnsTtlMs` is not a finite number `>= 0`, or a
   *   timeout option is not a whole number of milliseconds in `1`–`2147483647`
   */
  constructor(options?: SmtpProviderOptions, runtime?: SmtpRuntime) {
    this.#options = options ?? {};
    this.#runtime = runtime;
    for (const name of ['connectionTimeoutMs', 'greetingTimeoutMs', 'socketTimeoutMs'] as const) {
      const value = this.#options[name];
      // nodemailer passes these to `socket.setTimeout`, which throws inside a
      // socket callback for a negative or infinite value — a process crash —
      // and silently uses its default for 0 or NaN.
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS)
      ) {
        throw new RangeError(
          `SmtpProvider options.${name} must be a whole number of milliseconds between 1 and ${MAX_TIMER_MS}`,
        );
      }
    }
    const ttl = this.#options.dnsTtlMs;
    if (ttl !== undefined) {
      if (!Number.isFinite(ttl) || ttl < 0) {
        throw new RangeError('SmtpProvider options.dnsTtlMs must be a finite number >= 0');
      }
      if (this.#options.host === undefined) {
        throw new Error('SmtpProvider options.dnsTtlMs needs options.host to resolve');
      }
      if (this.#options.transport !== undefined) {
        throw new Error(
          'SmtpProvider options.dnsTtlMs cannot apply to an injected transport, which resolves its own host',
        );
      }
      if (runtime?.dns === undefined) {
        throw new Error(
          'SmtpProvider options.dnsTtlMs needs a runtime with DNS (IRuntimeServices.dns), and this runtime has none',
        );
      }
    }
  }

  async connect(): Promise<void> {
    const injected = this.#options.transport;
    if (injected !== undefined) {
      if (!validateSmtpTransport(injected)) {
        throw new Error('Injected SMTP transport is missing the required sendMail method');
      }
      this.#transport = injected;
    } else {
      const generation = this.#generation;
      const module = await loadNodemailerModule();
      // A disconnect while the module loaded wins: the provider stays closed.
      if (generation !== this.#generation) throw notConnected();
      this.#module = module;
      const transport = this.#usesDnsTtl()
        ? await this.#refreshTransport()
        : adaptNodemailerModule(this.#module, this.#options);
      if (generation !== this.#generation) {
        this.#retire(transport);
        if (this.#transport === transport) this.#transport = null;
        throw notConnected();
      }
      this.#transport = transport;
    }
    this.#installProbe();
  }

  /** `true` when the provider resolves the host itself (`dnsTtlMs` on a name). */
  #usesDnsTtl(): boolean {
    const host = this.#options.host;
    return this.#options.dnsTtlMs !== undefined && host !== undefined && !isIpLiteral(host);
  }

  /**
   * Under `dnsTtlMs`: re-resolves the host once its answer is older than the
   * TTL, and replaces the transport when the address changed. Returns the
   * transport to use.
   */
  #refreshTransport(): Promise<ISmtpTransport> {
    const generation = this.#generation;
    if (this.#refresh?.generation === generation) return this.#refresh.promise;
    const refresh = { generation, promise: this.#resolveTransport(generation) };
    this.#refresh = refresh;
    void refresh.promise
      .finally(() => {
        if (this.#refresh === refresh) this.#refresh = null;
      })
      .catch(() => {});
    return refresh.promise;
  }

  async #resolveTransport(generation: number): Promise<ISmtpTransport> {
    const runtime = this.#runtime!;
    const now = runtime.hrtime();
    if (this.#transport !== null && now - this.#triedAt < this.#options.dnsTtlMs!) {
      return this.#transport;
    }
    this.#triedAt = now;
    const host = this.#options.host!;
    let address: string | undefined;
    try {
      address = (
        await withDeadline(() => runtime.dns!.resolveHost(host), {
          timeoutMs: this.#options.connectionTimeoutMs ?? 120_000,
          onTimeout: () => new Error(`SmtpProvider: DNS lookup for '${host}' timed out`),
          ...(runtime.timing === undefined ? {} : { timing: runtime.timing }),
        })
      )[0];
    } catch (error) {
      // A failed or timed-out refresh keeps the last good transport; with none
      // yet, nodemailer resolves the name itself (the runtime resolver reads
      // DNS only, so a name only `/etc/hosts` knows still connects).
      if (generation !== this.#generation) throw notConnected();
      if (this.#transport !== null) return this.#transport;
      if (this.#module === null) throw error;
      this.#transport = adaptNodemailerModule(this.#module, this.#options);
      return this.#transport;
    }
    if (generation !== this.#generation) throw notConnected();
    if (address === undefined) {
      if (this.#transport !== null) return this.#transport;
      throw new Error(`SmtpProvider: '${host}' resolved to no address`);
    }
    if (this.#transport !== null && address === this.#address) {
      return this.#transport;
    }
    if (this.#transport !== null) this.#retire(this.#transport);
    this.#address = address;
    this.#transport = adaptNodemailerModule(this.#module!, this.#options, address);
    return this.#transport;
  }

  /** A refresh must not close a transport while an earlier send still uses it. */
  #retire(transport: ISmtpTransport): void {
    if ((this.#users.get(transport) ?? 0) > 0) this.#retired.add(transport);
    else this.#close(transport);
  }

  #close(transport: ISmtpTransport): void {
    if (this.#closed.has(transport)) return;
    this.#closed.add(transport);
    transport.close?.();
  }

  /** The transport for the next call, refreshed first under `dnsTtlMs`. */
  // eslint-disable-next-line require-await -- the not-connected refusal must REJECT, not throw synchronously
  async #currentTransport(): Promise<ISmtpTransport> {
    if (this.#transport === null) {
      throw notConnected();
    }
    return this.#usesDnsTtl() ? this.#refreshTransport() : this.#transport;
  }

  /**
   * M70c: installs `isHealthy` from the transport's `verify()` when present;
   * leaves it absent (unknown) otherwise.
   */
  #installProbe(): void {
    const transport = this.#transport;
    if (transport !== null && typeof transport.verify === 'function') {
      this.isHealthy = async (): Promise<boolean> => {
        try {
          await this.#useTransport((current) => current.verify!());
          return true;
        } catch {
          return false;
        }
      };
    } else {
      delete this.isHealthy;
    }
  }

  disconnect(): Promise<void> {
    this.#generation++;
    const transport = this.#transport;
    this.#transport = null;
    this.#address = undefined;
    this.#triedAt = Number.NEGATIVE_INFINITY;
    delete this.isHealthy;
    return Promise.resolve().then(() => {
      if (transport !== null) this.#retire(transport);
    });
  }

  isReady(): boolean {
    return this.#transport !== null;
  }

  /**
   * Sends a message over SMTP.
   *
   * @param message - The outgoing mail
   * @throws {Error} If the provider is not connected or the transport rejects
   */
  async send(message: OutgoingMail): Promise<void> {
    await this.#useTransport((transport) => transport.sendMail(toNodemailerMessage(message)));
  }

  /** Pins a transport for a send or probe until that operation settles. */
  async #useTransport(run: (transport: ISmtpTransport) => Promise<unknown>): Promise<void> {
    const transport = await this.#currentTransport();
    this.#users.set(transport, (this.#users.get(transport) ?? 0) + 1);
    try {
      await run(transport);
    } finally {
      const remaining = this.#users.get(transport)! - 1;
      if (remaining > 0) this.#users.set(transport, remaining);
      else {
        this.#users.delete(transport);
        if (this.#retired.delete(transport)) this.#close(transport);
      }
    }
  }
}
