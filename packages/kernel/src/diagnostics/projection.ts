/**
 * Diagnostics projection — the pure half of kernel diagnostics: label
 * allowlist compilation and bounded primitive projection.
 *
 * Every string that can leave the process through a diagnostics snapshot or
 * event batch passes through the allowlists compiled here, at the capture
 * boundary and never again. An allowlist is an EXACT set of registration
 * strings — no globs, no regular expressions — because approving a label is a
 * disclosure decision the developer makes per name, not a pattern match to be
 * widened.
 *
 * @module
 */
import type {
  DiagnosticsEdge,
  DiagnosticsNode,
  DiagnosticsSnapshot,
  HttpMethod,
} from '@setu-ts/common';

/**
 * Explicit label allowlists for the four projected name families. A name
 * leaves the process only when it exactly matches an entry here; unknown names
 * authorize no output.
 *
 * @since 0.8.0
 */
export interface KernelDiagnosticsLabelOptions {
  /** Exact plugin `name` values that may appear as node labels. */
  readonly plugins?: readonly string[];
  /** Exact capability-token strings that may appear as node labels. */
  readonly capabilities?: readonly string[];
  /** Exact registered route patterns (including group prefix) that may appear as labels. */
  readonly routes?: readonly string[];
  /** Exact declared middleware names that may appear as labels. */
  readonly middleware?: readonly string[];
}

/**
 * Options enabling kernel diagnostics, supplied as
 * `createApplication({ diagnostics })`. The presence of the option IS the
 * activation: an omitted option creates no collector, metadata mirror, ring
 * buffer, or timer anywhere in the kernel.
 *
 * @since 0.8.0
 */
export interface KernelDiagnosticsOptions {
  /**
   * Explicit label allowlists. Omitted entirely, every projected node carries
   * only its opaque identifier — no name, template, or version ever leaves the
   * process.
   */
  readonly labels?: KernelDiagnosticsLabelOptions;
}

/** Maximum entries accepted in one label allowlist. */
export const MAX_LABEL_LIST_ENTRIES = 256;

/** Maximum UTF-8 byte length of one allowlist entry. */
export const MAX_LABEL_BYTES = 160;

/** A compiled allowlist set per label family. */
export interface DiagnosticsLabelAllowlists {
  readonly plugins: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<string>;
  readonly routes: ReadonlySet<string>;
  readonly middleware: ReadonlySet<string>;
}

/** C0/C1 control code points, described by code point to avoid a literal regex class. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Compiles one allowlist, refusing malformed input with VALUE-FREE errors: an
 * error must state the constraint it enforces, never echo the offending value,
 * because a construction-time diagnostic failure is an attacker-reachable path
 * for whatever the list contains.
 *
 * @param entries - The raw allowlist, or `undefined` for an empty set
 * @param listName - Family name used in the error text only
 * @returns The compiled exact-match set
 * @throws {RangeError} When the list exceeds 256 entries, an entry exceeds 160
 * UTF-8 bytes, or an entry contains a control character — without naming any entry
 * @since 0.8.0
 */
export function compileLabelAllowlist(
  entries: readonly string[] | undefined,
  listName: string,
): ReadonlySet<string> {
  if (entries === undefined) {
    return new Set<string>();
  }
  if (entries.length > MAX_LABEL_LIST_ENTRIES) {
    throw new RangeError(
      `Invalid diagnostics labels.${listName}: more than ${MAX_LABEL_LIST_ENTRIES} entries.`,
    );
  }
  const compiled = new Set<string>();
  for (const entry of entries) {
    const bytes = new TextEncoder().encode(entry).length;
    if (bytes > MAX_LABEL_BYTES) {
      throw new RangeError(
        `Invalid diagnostics labels.${listName}: an entry exceeds the ${MAX_LABEL_BYTES}-byte bound.`,
      );
    }
    if (hasControlCharacter(entry)) {
      throw new RangeError(
        `Invalid diagnostics labels.${listName}: an entry contains a control character.`,
      );
    }
    compiled.add(entry);
  }
  return compiled;
}

/**
 * Compiles every label family of a {@linkcode KernelDiagnosticsOptions}.
 *
 * @param options - The diagnostics options, or `undefined` for all-empty lists
 * @returns The compiled allowlists
 * @throws {RangeError} When any list is malformed (see {@linkcode compileLabelAllowlist})
 * @since 0.8.0
 */
export function compileLabelAllowlists(
  options: KernelDiagnosticsOptions | undefined,
): DiagnosticsLabelAllowlists {
  const labels = options?.labels;
  return {
    plugins: compileLabelAllowlist(labels?.plugins, 'plugins'),
    capabilities: compileLabelAllowlist(labels?.capabilities, 'capabilities'),
    routes: compileLabelAllowlist(labels?.routes, 'routes'),
    middleware: compileLabelAllowlist(labels?.middleware, 'middleware'),
  };
}

/**
 * Projects a candidate registration string through an allowlist.
 *
 * Exact membership, never a truncation: a name either IS an approved label or
 * it is omitted — truncating a 200-byte route pattern into an approved-looking
 * prefix would mint a new name that was never disclosed on purpose.
 *
 * @param allowlist - The compiled exact-match set for this family
 * @param candidate - The raw registration string
 * @returns The candidate itself when approved, `undefined` otherwise
 * @since 0.8.0
 */
export function approvedLabel(
  allowlist: ReadonlySet<string>,
  candidate: string,
): string | undefined {
  return allowlist.has(candidate) ? candidate : undefined;
}

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/**
 * Projects a method string onto the {@linkcode HttpMethod} vocabulary.
 * Unsupported input is omitted, never widened into a new name.
 *
 * @param method - The raw method string from a registration
 * @returns The known verb, or `undefined` when outside the vocabulary
 * @since 0.8.0
 */
export function projectHttpMethod(method: string): HttpMethod | undefined {
  return HTTP_METHODS.has(method) ? (method as HttpMethod) : undefined;
}

/**
 * Bounded plugin-version grammar. A version is emitted only when it is a plain
 * `major.minor.patch` semver (optionally with prerelease/build suffixes) within
 * 64 characters — anything else (a git sha, a sentence, a hostile string) is
 * omitted rather than projected.
 *
 * @param version - The raw plugin `version` string
 * @returns The version when it passes the bounded grammar, `undefined` otherwise
 * @since 0.8.0
 */
export function boundedPluginVersion(version: string): string | undefined {
  if (version.length === 0 || version.length > 64) {
    return undefined;
  }
  const bounded = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
  return bounded.test(version) ? version : undefined;
}

/**
 * Inclusive monotonic elapsed time for one observed boundary.
 *
 * @param clock - The injected monotonic clock
 * @param startedAtMs - The boundary's recorded start offset, or `null`
 * @returns Elapsed ms, or `null` when either reading was unavailable
 * @since 0.8.0
 */
export function monotonicElapsed(
  clock: () => number | null,
  startedAtMs: number | null,
): number | null {
  if (startedAtMs === null) {
    return null;
  }
  const finishedAtMs = clock();
  return finishedAtMs === null ? null : finishedAtMs - startedAtMs;
}

/**
 * Advances a monotonic counter with saturation at `Number.MAX_SAFE_INTEGER`.
 * Returns `null` at saturation, which callers treat as "stop collection": a
 * coarse failure state long before any identifier could wrap into a
 * misleading value.
 *
 * @param current - The current counter value
 * @returns The next value, or `null` when the counter is saturated
 * @since 0.8.0
 */
export function saturatingNext(current: number): number | null {
  return current >= Number.MAX_SAFE_INTEGER ? null : current + 1;
}

/** Fixed v1 limits: composition nodes retained by the collector. */
export const MAX_NODES = 1024;

/** Fixed v1 limits: composition edges retained by the collector. */
export const MAX_EDGES = 4096;

/** Fixed v1 limits: snapshot budget as the exact UTF-8 byte length of the compact JSON. */
export const MAX_SNAPSHOT_BYTES = 262_144;

/**
 * Applies the fixed 256 KiB snapshot budget to the final DTO: the exact UTF-8
 * byte length of the compact JSON encoding of the RETURNED object is the
 * number the wire consumer measures, so trimming runs on the final shape —
 * omitting later entries (with their edges) and setting `truncated` until it
 * fits.
 *
 * Extracted as a pure seam because the retained-field bounds make the budget
 * unreachable through real captures (1,024 bounded nodes stay well under the
 * cap); the defense still carries the bar, so the decidable trim is tested
 * here directly rather than left behind an uncoverable branch.
 *
 * @param scalar - The snapshot's scalar members (instanceId, state, failureCode, droppedEvents)
 * @param nodes - The projected nodes, oldest first
 * @param edges - The projected edges, oldest first
 * @param truncated - The topology truncation flag
 * @returns The bounded snapshot DTO
 * @since 0.8.0
 */
export function applySnapshotBudget(
  scalar: {
    readonly instanceId: string | null;
    readonly state: DiagnosticsSnapshot['state'];
    readonly failureCode: DiagnosticsSnapshot['failureCode'];
    readonly droppedEvents: number;
  },
  nodes: readonly DiagnosticsNode[],
  edges: readonly DiagnosticsEdge[],
  truncated: boolean,
): DiagnosticsSnapshot {
  const encoder = new TextEncoder();
  const build = (
    keptNodes: readonly DiagnosticsNode[],
    keptEdges: readonly DiagnosticsEdge[],
    isTruncated: boolean,
  ): DiagnosticsSnapshot => ({
    version: 1,
    instanceId: scalar.instanceId,
    state: scalar.state,
    failureCode: scalar.failureCode,
    nodes: keptNodes,
    edges: keptEdges,
    truncated: isTruncated,
    droppedEvents: scalar.droppedEvents,
  });
  const measure = (candidate: DiagnosticsSnapshot): number =>
    encoder.encode(JSON.stringify(candidate)).length;

  // Fast path: nothing to trim. Returning the inputs untouched also keeps the
  // untrimmed shape EXACTLY as it was — an edge whose endpoint is somehow
  // absent from `nodes` survives here, as it always did, rather than being
  // silently dropped by the retained-id filter below.
  const whole = build(nodes, edges, truncated);
  if (measure(whole) <= MAX_SNAPSHOT_BYTES) {
    return whole;
  }

  // Trimming keeps a PREFIX of the nodes, and dropping a suffix entry can only
  // shrink the encoding — so the encoded length is monotone in the retained
  // count and the largest fitting prefix is found by bisection. Dropping one
  // node per measurement instead is quadratic: 4,000 nodes cost ~2,700 full
  // `JSON.stringify` + encode passes (measured at ~1,000 ms) where bisection
  // costs ~12 (~4 ms). The measurement itself is unchanged — every candidate
  // is the exact compact UTF-8 length of the snapshot that would be returned.
  const at = (count: number): DiagnosticsSnapshot => {
    const keptNodes = nodes.slice(0, count);
    const keptIds = new Set(keptNodes.map((node) => node.id));
    // Equivalent to the cumulative per-drop filter: an edge survives exactly
    // when neither endpoint was dropped.
    const keptEdges = edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));
    return build(keptNodes, keptEdges, true);
  };

  let low = 0;
  let high = nodes.length - 1;
  let best = at(0);
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = at(mid);
    if (measure(candidate) <= MAX_SNAPSHOT_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
