# Milestone 119d — Forwarded Client Identity (`@setu-ts/http-security-plugin`)

> **Status:** Planning. Branch: `feat/m119d-forwarded-client-identity` (a **design** letter of
> M119). `develop` and `main` are protected — all work stays on this branch until it merges via one
> PR.

## 0. Objective & scope

M113n made the socket peer the last link of the forwarded chain and the chain trustworthy behind
`trustedProxies`. Two inputs still change who the client is (register rows V10-19, V10-28, from X78
in `smoke/X75-X82-FINDINGS.md`):

- **V10-19 (Medium, new in 0.10.0).** With `forwardedHeader: 'forwarded'` behind a proxy that
  APPENDS `Forwarded`, a client that sends one malformed element — or more than 64 elements, or more
  than 8 KiB — resolves to no client. `parseForwarded` refuses the whole field, so the walk sees
  only the trusted peer, and the rate-limit key and audit IP become the shared fallback bucket.
- **V10-28 (Low).** A forwarded client in IPv4-mapped form (`::ffff:198.51.100.7`) is published as
  written, while the socket peer is unmapped by the runtime, so one client has two identities.

- **In scope:** a malformed `Forwarded` element becomes a **boundary** in the chain instead of
  voiding the field; the 8 KiB / 64-element bounds bound the work from the right instead of voiding
  the field; ONE normalizer for every address IP security publishes or compares.
- **NOT this milestone:** CLI wiring of `ipSecurity`/`trustedProxies` in templates and the React
  Router 400 behind TLS termination (X78-1/G6 — M119c); IPv6 CIDR expansion (deliberately
  unsupported, unchanged); validating that `X-Forwarded-For` entries are IP literals (unchanged,
  §9).

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                                   | Verified surface / fact                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseForwarded`                  | `packages/http-security-plugin/src/middleware/forwarded-header.ts:19-75`             | Strict left-to-right RFC 7239 parser; returns `undefined` for the WHOLE field on any malformed element, on more than 64 elements, or above 8192 UTF-16 units or UTF-8 bytes. Internal (`@internal`), not in `src/index.ts`; only importer is `ip-security-middleware.ts:17` |
| `IForwardedElement`               | `forwarded-header.ts:4-8`                                                            | `{ ip?, proto?, host? }`; an absent `ip` is an unknown/obfuscated hop                                                                                                                                                                                                       |
| `parseNode`                       | `forwarded-header.ts:78-98`                                                          | `null` = malformed node; `undefined` = `unknown`/obfuscated; IPv6 returned as the bracket contents as written (not canonicalized)                                                                                                                                           |
| middleware chain build            | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:262-305`     | `elements ?? []` → a malformed field contributes no hops; peer appended in `trustedProxies` mode; `ip = selected` published un-normalized (`:291`, the V10-28 site)                                                                                                         |
| `resolveForwardedIndex`           | `ip-security-middleware.ts:333-366`                                                  | Three modes: trusted walk from the right (an `undefined` entry is untrusted and returned as the client index), `proxyHops` nth-from-right, leftmost `0`                                                                                                                     |
| `compileTrustedProxy`/`unmapIpv4` | `ip-security-middleware.ts:124-202`                                                  | Matchers unmap `::ffff:a.b.c.d` and lowercase, for matching only; IPv4 CIDR numeric, everything else literal string compare                                                                                                                                                 |
| origin selection                  | `ip-security-middleware.ts:296-305`                                                  | Forwarded origin read from `elements[index]` only when the walk passed a trusted peer and `index < forwardedLength`                                                                                                                                                         |
| runtime peer form                 | `packages/runtime/src/adapters/shared/fetch-mapping.ts:28`                           | Runtime unmaps a mapped IPv4 socket peer; IPv6 peers arrive as the runtime gives them                                                                                                                                                                                       |
| `CLIENT_IP_STATE_KEY` consumers   | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts`, `common/src/http.ts` | The published value keys the rate limiter and audit; a string whose form changes changes the key                                                                                                                                                                            |
| URL IPv6 canonicalization         | WHATWG URL (Node 24, Deno, Bun)                                                      | `new URL('http://[2001:DB8:0::1]').hostname === '[2001:db8::1]'`; a zone id or invalid literal throws. `::ffff:1.2.3.4` canonicalizes to `[::ffff:102:304]`, so IPv4 unmapping must run FIRST (all four forms probed on Node 24, 2026-10-25)                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                         | Resolution (picked side)                     | Doc deliverable (same PR)                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | README, PUBLIC_API.md and `docs/deployment.md` state that a malformed or oversized `Forwarded` header "contributes no hops", so a trusted proxy sending one yields no client — the V10-19 defect | The boundary rule of §3.1–§3.2 replaces it   | `packages/http-security-plugin/README.md` (IP section), PUBLIC_API.md `IpSecurityOptions.forwardedHeader` paragraph, `docs/deployment.md` |
| C2  | README says "IPv4-mapped peers such as `::ffff:10.1.2.3` become `10.1.2.3`" — true of the peer only                                                                                              | Every published address is normalized (§3.3) | Same README paragraph and PUBLIC_API.md; CHANGELOG notes the key change for mapped and non-canonical IPv6 clients                         |

## 3. Design decisions

### 3.1 A malformed element is a boundary, not a void

- **Decision:** `parseForwarded` always returns an array (never `undefined`) of wire-order entries,
  each an `IForwardedElement` or the marker `MALFORMED` (a `unique symbol` constant exported from
  the file only; the return type is `readonly (IForwardedElement | typeof MALFORMED)[]`). An empty
  field returns `[MALFORMED]`, which every mode resolves exactly as today's empty chain does. The
  middleware's `elements ?? []` fallback is removed, and `resolveForwardedIndex` takes chain entries
  of type `string | undefined | typeof MALFORMED`. Parsing is two-phase:
  1. **Strict pass** — the existing grammar over the whole field. If it succeeds within the bounds,
     its elements are the result (unchanged output for every well-formed field, including quoted
     values that contain commas such as `ext="a\",b"`).
  2. **Recovery pass**, only when the strict pass fails or a bound is exceeded — split the field on
     `,` and parse segments from the RIGHT, each with the same element grammar. Well-formed segments
     are kept in order; the first segment (scanning right to left) that does not parse, and
     everything to its left, collapse into ONE leading `MALFORMED` entry. The recovery split is not
     quote-aware: a trusted proxy that writes a comma inside a quoted value AND sits to the right of
     malformed client input loses that element to the boundary, which resolves no client (fail
     closed, §8a).
- **Selection rule (`resolveForwardedIndex`):** a selection may never land on or cross a boundary.
  - `trustedProxies`: walking from the right, reaching `MALFORMED` before an untrusted entry returns
    `undefined`. An untrusted entry to the right of the boundary is the client as before.
  - `proxyHops`: an index that lands on `MALFORMED`, or with a `MALFORMED` entry anywhere to its
    right, returns `undefined`.
  - leftmost (neither option): a chain containing `MALFORMED` returns `undefined` (the entry at
    index 0 is, or lies left of, the boundary).
- **Why:** the elements to the right of the boundary were written by later hops; the walk only ever
  needs the right tail. Option "discard and use the proxy address" re-creates the shared bucket;
  option "skip the malformed element" lets the walk continue LEFT into client-written text past a
  hop it could not read, which is the spoof M113n closed.
- **Test home:** `forwarded-header.test.ts` (strict output unchanged for every existing well-formed
  case; recovery tables), `ip-security-proxy.test.ts` (selection per mode), `proxy-security.test.ts`
  (end to end through a kernel app).

### 3.2 Bounds bound the work, from the right

- **Decision:** the recovery pass first slices the trailing window of the field (at most 8192 UTF-8
  bytes, cut at a code-point boundary) and splits only that window, so nothing proportional to the
  full field is allocated; when the window was cut, its first segment is partial and is treated as
  the boundary. It parses at most 64 segments; when one of the two budgets runs out before the left
  end, the remainder is the leading `MALFORMED` boundary. A field the strict pass accepts is still
  capped at 64 elements and 8 KiB (unchanged); exceeding a bound sends it to recovery instead of
  voiding it. Recovery is linear in the examined window (each segment parsed once).
- **Why:** a client padding the header to exceed a bound must not erase its own identity behind an
  appending proxy; the bound must still cap per-request work.
- **Test home:** `forwarded-header.test.ts` — 65 elements → 64 kept, leading boundary; an 8 KiB+
  client prefix → the appended element kept; a 16 KiB field → bounded time (assert result, not
  timing).

### 3.3 One normalizer for every address

- **Decision:** a single internal `normalizeIp(value: string): string` in a new file
  `src/middleware/normalize-ip.ts` (not exported from `src/index.ts`): (1) unmap `::ffff:a.b.c.d` to
  `a.b.c.d` (the existing `unmapIpv4` logic, moved here); (2) else, if the value contains `:` and
  parses as a bracketed IPv6 URL host, return the canonical lowercase compressed form; (3) else
  return the value unchanged. It is applied to: the published `CLIENT_IP_STATE_KEY` value in every
  mode, including `trustProxy: false` (the peer); each chain entry once per request before trusted
  matching; and each `trustedProxies` literal at construction (replacing
  `unmapIpv4(...).toLowerCase()` in `compileTrustedProxy`). IPv4 CIDR matching is unchanged.
- **Why:** V10-28, and the same identity split for `2001:DB8::1` vs `2001:db8::1`. One function for
  publish and compare means a trusted literal and a forwarded hop can never disagree on form.
- **Test home:** `normalize-ip.test.ts` (table: mapped IPv4, upper-case and uncompressed IPv6, zone
  id unchanged, garbage unchanged, IPv4 unchanged); `ip-security-middleware.test.ts` (mapped
  forwarded client and mapped peer publish the same key; uncompressed IPv6 trusted literal matches).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — no exported signature changes. Behaviour change for operators:
a forwarded client in IPv4-mapped or non-canonical IPv6 form is now published normalized, which
changes its rate-limit/audit key on upgrade; ships in minor 0.11.0 and is called out in CHANGELOG.

| Exported symbol                        | Kind     | Consumer / real code path that READS it                               |
| -------------------------------------- | -------- | --------------------------------------------------------------------- |
| `ipSecurityMiddleware` (unchanged API) | function | `HttpSecurityPlugin` and applications; behaviour changes as §3.1–§3.3 |

### 4.1 Options — every option names its consumer

| Option                          | Consumer                  | Behavior (per implementation)                                       |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| None added or changed (checked) | `IpSecurityOptions` as-is | `forwardedHeader`, `trustedProxies`, `proxyHops` keep their meaning |

## 5. Implementation files

| File                                                                     | Purpose                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `packages/http-security-plugin/src/middleware/forwarded-header.ts`       | strict + recovery passes; `MALFORMED` marker; element grammar factored for reuse |
| `packages/http-security-plugin/src/middleware/normalize-ip.ts` (new)     | `normalizeIp`, with `unmapIpv4`/`ipv4ToNumber` moved here                        |
| `packages/http-security-plugin/src/middleware/ip-security-middleware.ts` | boundary-aware `resolveForwardedIndex`; normalize once; publish normalized       |
| README, PUBLIC_API.md, `docs/deployment.md`, CHANGELOG                   | C1, C2; Unreleased entries for V10-19 and V10-28                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                  | src covered                     | Key assertions                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/forwarded-header.test.ts`       | `forwarded-header.ts`           | Every existing well-formed case gives the same elements. Recovery: each existing malformed input followed by `, for=198.51.100.7` yields `[MALFORMED, { ip: '198.51.100.7' }]`; unclosed quote, stray comma, duplicate param, bad node; 65 elements; 8 KiB+ prefix |
| `test/unit/normalize-ip.test.ts` (new)     | `normalize-ip.ts`               | §3.3 table                                                                                                                                                                                                                                                         |
| `test/unit/ip-security-proxy.test.ts`      | `ip-security-middleware.ts`     | Boundary per mode (§3.1); boundary with only trusted entries to its right → `undefined`; untrusted entry right of boundary → client; forwarded origin read from the selected element after recovery                                                                |
| `test/unit/ip-security-middleware.test.ts` | `ip-security-middleware.ts`     | §3.3 publish/compare; `trustProxy: false` peer normalized                                                                                                                                                                                                          |
| `test/integration/proxy-security.test.ts`  | all three, through a kernel app | V10-19 reproduction: appending-proxy chain `client-garbage, for=<client>` from a trusted peer → `CLIENT_IP_STATE_KEY` is `<client>`, and two clients get two rate-limit keys; V10-28: mapped forwarded client and same client direct share one key                 |

The URL canonical forms in §1 were probed on Node 24; the Deno lane runs the same tests. Bug-fix
proof: each V10-19/V10-28 test is shown failing on `develop`'s code.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m119d-forwarded-client-identity
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage http-security-plugin auth-plugin   # ≥90% every touched src file
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

## 8. Risks & mitigations

- Recovery changes which elements a deployment believes → the strict pass is unchanged for every
  well-formed field, and every existing well-formed parser case must give the same elements; the
  existing malformed and over-bound cases change from `undefined` to recovery output by design.
- A trusted proxy writing a quoted comma loses its element only when malformed input sits to its
  left → resolves `undefined` (fail closed), documented.
- Normalizing changes keys for mapped/uppercase IPv6 clients on upgrade → CHANGELOG entry; limiter
  windows are short-lived.
- Per-request cost of IPv6 canonicalization → only for entries containing `:`; one URL parse per
  entry examined.

## 8a. Design security review

- **Reviewed flows:** a request through zero or more proxies reaching `ipSecurityMiddleware` with
  `forwardedHeader: 'forwarded'` or `'x-forwarded'` in each mode (`trustedProxies`, `proxyHops`,
  leftmost, `trustProxy: false`); the published client IP keying `rateLimit` and audit; the
  published forwarded origin feeding cookies, CSRF and the React Router bridge.
- **Assets:** the integrity of the client identity (rate-limit key, audit IP, IP allowlists); the
  integrity of the published public origin; request-path CPU.
- **Attackers:** a direct client; a client behind an appending trusted proxy controlling every byte
  to the LEFT of what the proxy appends (malformed elements, quotes, commas, padding past the
  bounds); a client controlling `X-Forwarded-*` headers in the `Forwarded` family.
- **Budgets:** recovery examines at most 8192 bytes and 64 segments, each parsed once; no new
  per-request allocation proportional to anything beyond that window.
- **Audit obligations:**
  1. Behind a trusted appending proxy, no client-written byte to the left of the proxy's element can
     change the resolved client or the forwarded origin; prove with malformed, oversized,
     quote-injecting and comma-injecting prefixes, and with a negative control (recovery disabled →
     identity erased, the V10-19 state).
  2. A walk can never cross a boundary: a boundary with only trusted entries to its right resolves
     `undefined`, never an entry left of the boundary and never the peer.
  3. A direct client (untrusted peer) sending any `Forwarded` value is identified by its peer.
  4. Normalization cannot make an untrusted hop match a trusted entry it does not equal as an
     address; mapped and canonical forms of the same address get one key.
  5. The forwarded origin is still believed only through a trusted peer and only from the selected
     element.
  6. A 16 KiB header and 8000 commas complete within the budget (bounded work, asserted by result).

| Threat                                                                  | Resolution                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Client erases its identity behind an appending proxy (V10-19)           | §3.1 boundary + §3.2 right-anchored bounds                                  |
| Client walks the resolver past an unreadable hop into spoofed text      | §3.1: the walk stops at the boundary with `undefined`                       |
| One client, two keys (V10-28)                                           | §3.3 single normalizer on publish and compare                               |
| Quadratic work from a crafted header                                    | §3.2 linear recovery within the window                                      |
| Trusted proxy's quoted comma split by recovery                          | Fails closed to `undefined`; documented (§8)                                |
| Quadratic trim regex on inner whitespace (audit `8334b453`, M1, Medium) | FIXED after the audit: index-based `trimSegment`, with a test               |
| Userinfo accepted in a bracketed node (audit L1, Low, pre-existing)     | FIXED after the audit: brackets must hold only IPv6 characters, with a test |

## 9. Out of scope

- Template wiring of `ipSecurity` and the React Router action 400 behind TLS (X78-1, G6) — M119c.
- Validating `X-Forwarded-For` entries as IP literals: a non-address entry right of the trusted
  chain is still published as the identity, as before; a candidate for a later row if smoke shows
  impact.
- IPv6 CIDR expansion — deliberately unsupported (README), unchanged.
