/**
 * The ONE authorization policy evaluator, registered under
 * `CAPABILITIES.AUTHORIZATION_POLICIES`. The route guard, `@Can` and the
 * imperative `can`/`authorize` all reach it through that contract, so they
 * cannot disagree.
 *
 * @module
 */
import { serializeError } from '@setu-ts/common';
import type {
  IAuthorizationPolicyService,
  ILogger,
  IPrincipal,
  PolicyAbility,
  PolicyAbilityInfo,
  PolicyDefinition,
  PolicyRef,
} from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import { isAnonymousAbility, validatePolicyDefinition } from './define-policy.ts';
import { AuthorizationDeniedError, type PolicyDenial, UnknownPolicyError } from './errors.ts';

/** Shared, frozen descriptions — `describe` allocates nothing per call. */
const ANONYMOUS: PolicyAbilityInfo = Object.freeze({ anonymous: true });
const AUTHENTICATED: PolicyAbilityInfo = Object.freeze({ anonymous: false });

/** Which hook threw, for the log line. */
type Stage = 'before' | 'check';

/**
 * Labels a policy reference that is not a usable string, for an error message,
 * without ever converting the value (a `String(value)` can throw).
 */
function refName(policy: unknown): string {
  if (typeof policy === 'string') {
    return policy;
  }
  if (typeof policy === 'object' && policy !== null) {
    const name = (policy as { readonly name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return `[${typeof policy}]`;
}

/**
 * Evaluates registered authorization policies.
 *
 * Internal: AuthPlugin constructs and registers it; applications reach it
 * through `IAuthorizationPolicyService`.
 */
export class PolicyService implements IAuthorizationPolicyService {
  readonly #policies = new Map<string, PolicyDefinition>();
  readonly #logger: () => ILogger | undefined;
  #sealed = false;

  /**
   * @param logger - Read at CALL time, so a logger registered after the
   *   plugin's `register()` still receives the report
   */
  constructor(logger: () => ILogger | undefined) {
    this.#logger = logger;
  }

  /** @inheritdoc */
  define(policy: PolicyDefinition): void {
    if (this.#sealed) {
      throw new AuthPluginConfigurationError(
        'auth-plugin: authorization policies cannot be defined once the application has started',
      );
    }
    const validated = validatePolicyDefinition(policy);
    if (this.#policies.has(validated.name)) {
      throw new AuthPluginConfigurationError(
        `auth-plugin: an authorization policy named ${JSON.stringify(validated.name)} is already ` +
          'registered',
      );
    }
    this.#policies.set(validated.name, validated);
  }

  /** @inheritdoc */
  describe(policy: string, ability: string): PolicyAbilityInfo | undefined {
    const found = this.#ability(policy, ability);
    if (found === undefined) {
      return undefined;
    }
    return isAnonymousAbility(found.ability) ? ANONYMOUS : AUTHENTICATED;
  }

  /** @inheritdoc */
  async can<A extends string, T>(
    principal: IPrincipal | null,
    policy: PolicyRef<A, T>,
    ability: A,
    target?: T,
  ): Promise<boolean> {
    return (await this.#evaluate(principal, policy, ability, target)) === null;
  }

  /** @inheritdoc */
  async authorize<A extends string, T>(
    principal: IPrincipal | null,
    policy: PolicyRef<A, T>,
    ability: A,
    target?: T,
  ): Promise<void> {
    const denial = await this.#evaluate(principal, policy, ability, target);
    if (denial !== null) {
      throw new AuthorizationDeniedError(denial, refName(policy), ability);
    }
  }

  /**
   * Refuses every later `define`. AuthPlugin calls it once its startup scan
   * has passed, so the policy set is fixed for the life of the application.
   */
  seal(): void {
    this.#sealed = true;
  }

  /** Looks up a registered ability by OWN key only. */
  #ability(
    policy: unknown,
    ability: unknown,
  ): { readonly definition: PolicyDefinition; readonly ability: PolicyAbility<never> } | undefined {
    if (typeof policy !== 'string' || typeof ability !== 'string') {
      return undefined;
    }
    const definition = this.#policies.get(policy);
    if (definition === undefined || !Object.hasOwn(definition.abilities, ability)) {
      return undefined;
    }
    return { definition, ability: definition.abilities[ability] as PolicyAbility<never> };
  }

  /**
   * Evaluates one ability.
   *
   * @returns `null` when allowed, otherwise why it was denied
   * @throws {UnknownPolicyError} — as a rejection — for an unknown policy or ability
   */
  async #evaluate(
    principal: IPrincipal | null,
    policy: unknown,
    ability: unknown,
    target: unknown,
  ): Promise<PolicyDenial | null> {
    const name = refName(policy);
    const found = this.#ability(name, ability);
    if (found === undefined) {
      throw this.#policies.has(name)
        ? new UnknownPolicyError(
          name,
          typeof ability === 'string' ? ability : `[${typeof ability}]`,
        )
        : new UnknownPolicyError(name);
    }
    const abilityName = ability as string;
    const denial: PolicyDenial = principal === null
      ? 'authentication-required'
      : 'insufficient-privileges';
    const entry = found.ability;
    if (principal === null && !isAnonymousAbility(entry)) {
      return denial;
    }
    const { definition } = found;
    if (principal !== null && definition.before !== undefined) {
      let verdict: unknown;
      try {
        verdict = await definition.before(principal, abilityName, target as never);
      } catch (error) {
        this.#report(name, abilityName, 'before', error);
        return denial;
      }
      if (verdict === true) {
        return null;
      }
      if (verdict !== undefined) {
        return denial;
      }
    }
    let allowed: unknown;
    try {
      allowed = typeof entry === 'function'
        ? await entry(principal as IPrincipal, target as never)
        : await entry.check(principal, target as never);
    } catch (error) {
      this.#report(name, abilityName, 'check', error);
      return denial;
    }
    return allowed === true ? null : denial;
  }

  /**
   * Reports a throwing policy. Never the target and never the principal: the
   * line names the policy, the ability and the hook. A throwing logger cannot
   * change the outcome — the caller has already decided to deny.
   */
  #report(policy: string, ability: string, stage: Stage, error: unknown): void {
    try {
      this.#logger()?.error('Authorization policy threw; access denied', {
        policy,
        ability,
        stage,
        error: serializeError(error),
      });
    } catch {
      // Deliberately discarded: logging must not turn a deny into a failure.
    }
  }
}
