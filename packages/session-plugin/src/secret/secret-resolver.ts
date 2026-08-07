/**
 * Session secret resolution.
 *
 * Runs once during `register()` so a misconfigured secret fails at startup
 * rather than on the first login — every session is unreadable without it, and
 * discovering that in production traffic is strictly worse than at boot.
 *
 * @module
 */
import type { ISecretManager, IServiceRegistry } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { SessionSecretMissingError } from '../errors.ts';
import type { SessionPluginOptions } from '../options.ts';

/** Default name looked up in the secret manager and the environment. */
const DEFAULT_SECRET_NAME = 'SESSION_SECRET';

/**
 * Shortest acceptable secret. HKDF tolerates any length, but a short secret is
 * brute-forceable regardless of the derivation, so it is refused outright.
 */
export const MIN_SECRET_LENGTH = 32;

/** What the resolver needs to look a secret up. */
export interface SecretResolverDeps {
  /** The registry, used to find `CAPABILITIES.SECRETS` when it is registered. */
  readonly services: IServiceRegistry;
  /** Environment variables, from `IRuntimeServices.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves the ordered secret list.
 *
 * Precedence: an explicitly supplied `secret` option wins; otherwise
 * `CAPABILITIES.SECRETS` when registered; otherwise the environment. The secrets
 * manager is tried inside a `catch` because `ISecretManager.get` throws on a
 * missing secret rather than returning `null`, which is the same shape as the
 * reference implementation's Key-Vault-then-env fallback.
 *
 * @param options - The plugin options
 * @param deps - Registry and environment access
 * @returns Secrets in priority order; index 0 seals new cookies
 * @throws {SessionSecretMissingError} If no secret is found, or any is too short
 * @since 0.2.0
 */
export async function resolveSecrets(
  options: SessionPluginOptions,
  deps: SecretResolverDeps,
): Promise<readonly string[]> {
  const name = options.secretName ?? DEFAULT_SECRET_NAME;

  if (options.secret !== undefined) {
    return validate(normalize(options.secret), 'the `secret` option');
  }

  const fromManager = await readFromManager(deps.services, name);
  if (fromManager !== undefined) {
    return validate([fromManager], `secret '${name}' from the secrets manager`);
  }

  const fromEnv = deps.env[name];
  if (fromEnv !== undefined && fromEnv !== '') {
    return validate(normalizeEnv(fromEnv), `environment variable ${name}`);
  }

  throw new SessionSecretMissingError(
    `No session secret. Supply SessionPlugin({ secret }), register a secrets provider ` +
      `holding '${name}', or set the ${name} environment variable ` +
      `(minimum ${MIN_SECRET_LENGTH} characters).`,
  );
}

/**
 * Reads the secret from the secrets capability, treating both an absent
 * capability and a failed lookup as "not found" so the env fallback applies.
 */
async function readFromManager(
  services: IServiceRegistry,
  name: string,
): Promise<string | undefined> {
  if (!services.has(CAPABILITIES.SECRETS)) {
    return undefined;
  }
  const manager = services.get<ISecretManager>(CAPABILITIES.SECRETS);
  try {
    const value = await manager.get(name);
    return value === '' ? undefined : value;
  } catch {
    // `get` throws when the secret is absent or access is denied. Falling
    // through to the environment is what makes a dev machine work against a
    // provider configured for production.
    return undefined;
  }
}

/** Normalizes the option's `string | readonly string[]` into a list. */
function normalize(secret: string | readonly string[]): readonly string[] {
  return typeof secret === 'string' ? [secret] : secret;
}

/**
 * Splits a comma-separated environment value into a rotation list, so a secret
 * can be rotated through the environment without a code change.
 */
function normalizeEnv(value: string): readonly string[] {
  return value.split(',').map((part) => part.trim()).filter((part) => part !== '');
}

/** Rejects an empty list or any member below the minimum length. */
function validate(secrets: readonly string[], source: string): readonly string[] {
  if (secrets.length === 0) {
    throw new SessionSecretMissingError(`${source} resolved to an empty secret list.`);
  }
  for (const [index, secret] of secrets.entries()) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new SessionSecretMissingError(
        `Session secret at index ${index} from ${source} is ${secret.length} characters; ` +
          `at least ${MIN_SECRET_LENGTH} are required.`,
      );
    }
  }
  return secrets;
}
