/** JWT key resolution and the RFC 7518 HS256 key floor. @module */
import type { IServiceRegistry } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import type { JwtOptions } from '../interfaces/index.ts';

const SECRET_NAME = 'JWT_SECRET';

/** Resolves the algorithm from explicit configuration, then RS256 key material. */
export function jwtAlgorithm(options: JwtOptions): 'HS256' | 'RS256' {
  if (options.algorithm !== undefined) return options.algorithm;
  // The pre-0.13 precedence: an explicit secret means HS256, and any RS256 key
  // means RS256 (so a lone key still fails with the RS256 message); only a
  // configuration with neither resolves its HS256 secret from JWT_SECRET.
  if (options.secret !== undefined) return 'HS256';
  return options.privateKey !== undefined || options.publicKey !== undefined ? 'RS256' : 'HS256';
}

/** Refuses missing or short HS256 keys without including their value in the error. */
export function validateJwtSecret(secret: string | Uint8Array | undefined): string | Uint8Array {
  const length =
    typeof secret === 'string' ? new TextEncoder().encode(secret).byteLength : secret?.byteLength;
  if (length === undefined || length < 32) {
    throw new AuthPluginConfigurationError(
      `${SECRET_NAME} must supply at least 32 bytes for HS256 (RFC 7518 §3.2). ` +
        'Set it through jwt.secret, a secrets provider, configuration, or the environment.',
    );
  }
  return secret!;
}

/** Resolves option → secrets manager → configuration → environment at registration. */
export function resolveJwtSecret(
  options: JwtOptions,
  services: IServiceRegistry,
  env: Readonly<Record<string, string | undefined>>,
): string | Uint8Array | undefined | Promise<string | Uint8Array> {
  if (jwtAlgorithm(options) === 'RS256') {
    if (!options.privateKey || !options.publicKey) {
      throw new AuthPluginConfigurationError(
        'auth-plugin: RS256 requires both jwt.privateKey and jwt.publicKey PEM keys.',
      );
    }
    return undefined;
  }
  if (options.secret !== undefined) return validateJwtSecret(options.secret);
  if (services.has(CAPABILITIES.SECRETS)) {
    return readManager(services).then((value) =>
      value !== undefined && value !== ''
        ? validateJwtSecret(value)
        : configuredSecret(services, env),
    );
  }
  return configuredSecret(services, env);
}

/** A failed manager lookup permits the local configuration fallback. */
async function readManager(services: IServiceRegistry): Promise<string | undefined> {
  try {
    return await services.get(CAPABILITIES.SECRETS).get(SECRET_NAME);
  } catch {
    // A missing/inaccessible manager value falls through to local configuration.
    return undefined;
  }
}

/** Resolves the local sources shared by the absent-manager and failed-manager paths. */
function configuredSecret(
  services: IServiceRegistry,
  env: Readonly<Record<string, string | undefined>>,
): string | Uint8Array {
  const configured = services.has(CAPABILITIES.CONFIG)
    ? services.get(CAPABILITIES.CONFIG).get<unknown>(SECRET_NAME)
    : undefined;
  if (typeof configured === 'string' && configured !== '') return validateJwtSecret(configured);
  return validateJwtSecret(env[SECRET_NAME]);
}
