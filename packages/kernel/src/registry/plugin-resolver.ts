/**
 * Plugin dependency resolution: topological sort with cycle detection,
 * priority ordering, and the mandatory-runtime-first rule
 * (ARCHITECTURE.md §5, §7).
 *
 * @module
 */
import { CAPABILITIES } from '@hono-enterprise/common';
import type { CapabilityToken, IPlugin } from '@hono-enterprise/common';

/**
 * Resolves plugin registration order.
 *
 * Order is determined by: dependency edges first (a plugin's dependencies
 * register before it), then declared priority (lower first), then original
 * registration order. The plugin providing the `runtime` capability always
 * registers first, regardless of priority.
 */
export function resolvePluginOrder(plugins: readonly IPlugin[]): readonly IPlugin[] {
  assertUniqueNames(plugins);
  const providers = buildProviderIndex(plugins);

  const runtimeProvider = providers.get(CAPABILITIES.RUNTIME);
  if (runtimeProvider === undefined) {
    throw new Error(
      `No plugin provides the mandatory '${CAPABILITIES.RUNTIME}' capability. ` +
        `Register a runtime plugin (e.g. RuntimePlugin from @hono-enterprise/runtime).`,
    );
  }

  const dependenciesOf = (plugin: IPlugin): IPlugin[] => {
    const edges: IPlugin[] = [];
    // Every plugin implicitly depends on the runtime provider so it can rely
    // on ctx.runtime during registration.
    if (plugin !== runtimeProvider) {
      edges.push(runtimeProvider);
    }
    for (const token of plugin.dependencies ?? []) {
      const provider = providers.get(token);
      if (provider === undefined) {
        throw new Error(
          `Plugin '${plugin.name}' depends on capability '${token}', but no registered plugin provides it.`,
        );
      }
      if (provider !== plugin) {
        edges.push(provider);
      }
    }
    for (const token of plugin.optionalDependencies ?? []) {
      const provider = providers.get(token);
      if (provider !== undefined && provider !== plugin) {
        edges.push(provider);
      }
    }
    return edges;
  };

  return topologicalSort(plugins, dependenciesOf);
}

/**
 * One plugin's declared `consumes` capability for which no provider exists.
 * Used to build a soft startup diagnostic in the application.
 *
 * Unlike a missing {@linkcode IPlugin.dependencies} entry (which throws in
 * {@linkcode resolvePluginOrder}), an unsatisfied `consumes` is not a
 * resolve-time error: the plugin resolves the capability lazily at request
 * time, so the failure would otherwise surface only later, as a runtime throw
 * from `services.get`. Reporting it at startup names the consumer up front.
 */
export interface UnsatisfiedConsumer {
  /** Name of the plugin that declares the consumed capability. */
  readonly plugin: string;
  /** The consumed capability token that no registered plugin provides. */
  readonly capability: CapabilityToken;
}

/**
 * Finds every `consumes` capability, across all plugins, that `isProvided`
 * reports as absent.
 *
 * Pure by design: the caller supplies the provider check — in the kernel, the
 * live service registry's `has` after all plugins have registered, so
 * capabilities registered imperatively (not declared in `provides`) still
 * count as satisfied and never produce a false warning.
 *
 * @param plugins - All registered plugins
 * @param isProvided - Predicate: does a provider exist for this capability?
 * @returns One entry per unsatisfied (plugin, capability) pair, in plugin then
 * declaration order
 */
export function findUnsatisfiedConsumers(
  plugins: readonly IPlugin[],
  isProvided: (token: CapabilityToken) => boolean,
): readonly UnsatisfiedConsumer[] {
  const unsatisfied: UnsatisfiedConsumer[] = [];
  for (const plugin of plugins) {
    for (const capability of plugin.consumes ?? []) {
      if (!isProvided(capability)) {
        unsatisfied.push({ plugin: plugin.name, capability });
      }
    }
  }
  return unsatisfied;
}

function assertUniqueNames(plugins: readonly IPlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) {
      throw new Error(
        `Duplicate plugin name '${plugin.name}'. To replace a plugin, register the ` +
          `replacement's services with { override: true } instead of reusing the name.`,
      );
    }
    seen.add(plugin.name);
  }
}

/**
 * Indexes which plugin provides each capability token. A plugin implicitly
 * provides its own name, so `dependencies: ['logger-plugin']` also works.
 */
function buildProviderIndex(plugins: readonly IPlugin[]): Map<CapabilityToken, IPlugin> {
  const providers = new Map<CapabilityToken, IPlugin>();
  for (const plugin of plugins) {
    for (const token of [plugin.name, ...(plugin.provides ?? [])]) {
      const existing = providers.get(token);
      if (existing !== undefined && existing !== plugin) {
        throw new Error(
          `Capability '${token}' is provided by both '${existing.name}' and '${plugin.name}'. ` +
            `Multi-provider capabilities must be registered with { multi: true } at the service level.`,
        );
      }
      providers.set(token, plugin);
    }
  }
  return providers;
}

/**
 * Depth-first topological sort. Within the same dependency level, plugins
 * are visited by (priority, registration order), which the DFS preserves in
 * the output.
 */
function topologicalSort(
  plugins: readonly IPlugin[],
  dependenciesOf: (plugin: IPlugin) => IPlugin[],
): readonly IPlugin[] {
  const DEFAULT_PRIORITY = 500;
  const seeds = plugins
    .map((plugin, index) => ({ plugin, index }))
    .sort(
      (a, b) =>
        (a.plugin.priority ?? DEFAULT_PRIORITY) - (b.plugin.priority ?? DEFAULT_PRIORITY) ||
        a.index - b.index,
    )
    .map(({ plugin }) => plugin);

  const ordered: IPlugin[] = [];
  const done = new Set<IPlugin>();
  const inProgress = new Set<IPlugin>();

  const visit = (plugin: IPlugin, chain: readonly string[]): void => {
    if (done.has(plugin)) {
      return;
    }
    if (inProgress.has(plugin)) {
      const cycle = [...chain.slice(chain.indexOf(plugin.name)), plugin.name].join(' -> ');
      throw new Error(`Circular plugin dependency detected: ${cycle}`);
    }
    inProgress.add(plugin);
    for (const dependency of dependenciesOf(plugin)) {
      visit(dependency, [...chain, plugin.name]);
    }
    inProgress.delete(plugin);
    done.add(plugin);
    ordered.push(plugin);
  };

  for (const plugin of seeds) {
    visit(plugin, []);
  }
  return ordered;
}
