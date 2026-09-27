# Local Diagnostics Protocol — Design Security Review

The design security review for the M98b local diagnostics connector: the transport, pairing,
authentication, session and native-client design specified in
[`diagnostics-protocol.md`](./diagnostics-protocol.md). A committed-tree security audit of the
connector (`.roo/skills/security-audit/SKILL.md`) is checked against this document.

## Status and scope

**Completed 2026-09-27, retroactively.** M98b shipped (PR #347) with this review deferred: its plan
(`plans/archive/milestone-98b-local-diagnostics-connector.md`) records the threat design in §3 and
states that a security review must cover "bootstrap, MAC canonicalization, replay races,
origin/authority checks and post-await revocation", but it records no completed review. PR #370 then
audited the native client against an external contract audit and listed the missing review as a gap
on `main`. The plan is archived, and an archived plan is a design record that is not edited, so the
review lives here.

Because the code already exists, the review follows one rule: **it is derived from the committed
design — the plan's §3 and the protocol specification — not from the code.** A threat model written
by reading the implementation only describes what the implementation already does. Where the
implementation and this document disagree, that is a code finding for the audit, not a reason to
edit this document to match.

**In scope:** the runtime-owned loopback listener, the connector's request handling, the HMAC
request/response authentication, the session (sequence, instance binding, expiry, revocation), the
admission lanes and fixed bounds, the launch-time pairing handoff, and the native client.

**Out of scope:** the data surface of each inspector operation. M98d (health), M98e (configuration),
M98f (queues) and M98g (traces) each completed their own design review for what their operation may
carry, and a new inspector needs its own (ROADMAP, "Mandatory Security Audit Gates for M98d–M98n").
This review covers only the transport those operations share. The separately maintained devtool —
its launcher, UI and escaping of display strings — is not reviewed here.

## Reviewed flow

```text
native launcher ──(fresh sessionId + sessionKey, child-process environment only)──▶ application
  composition reads IRuntimeServices.env ──▶ DiagnosticsPlugin({ enabled, port, sessionId, sessionKey })
  └─ non-extractable HMAC-SHA-256 key imported; raw copy zeroed

native client ──GET + X-Setu-* headers──▶ Deno HTTP parser ──▶ runtime listener (127.0.0.1:<port>)
  native pre-mapping refusal (body framing, comma in a singleton header)
  ──▶ connector: anonymous admission ─▶ grammar / Host / Origin / target checks
  ──▶ session-ID match ─▶ verify lane (subtle.verify over canonical request bytes)
  ──▶ synchronous post-verify gate (generation, monotonic expiry, sequence advance)
  ──▶ session budget ─▶ instance binding ─▶ read M98a reader / inspector source
  ──▶ exact projection ─▶ serialize once ─▶ 256 KiB bound ─▶ post-await gate ─▶ sign ─▶ response

native client ──▶ bounded stream read (256 KiB, 5 s) ──▶ verify response MAC over exact bytes
  ──▶ instance binding ──▶ exact DTO validation ──▶ deep freeze ──▶ caller
```

Authority is established by one thing only: an HMAC under a per-launch key that never crosses the
wire. Loopback binding, `Host` and `Origin` checks, and admission lanes are hardening layered around
it, never a substitute for it.

## Assets

| Asset                        | Property protected         | Why it matters                                                                                                                |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Session key                  | Confidentiality, integrity | Holding it is holding the connection's authority, in both directions: it signs requests AND responses.                        |
| Session ID                   | Availability only          | Not an authenticator. It routes a request into the verify lane, so an attacker holding it can compete for that lane (see R3). |
| Diagnostic data              | Confidentiality            | Minimized by M98a and the inspector letters, but still application topology, labels, timings and failure codes.               |
| Instance identity            | Integrity                  | Binds a session to one process, so a key-holding peer cannot pass one application's data off as another's.                    |
| Parent application           | Availability               | The connector shares the process. Nothing on the diagnostics port may stop, slow or reroute the application's own traffic.    |
| Paired client's availability | Availability               | An unpaired flood must not lock the developer out of the session they launched.                                               |

## Attackers

In the supported threat model:

- **A1 — an unprivileged local process** (another user, or a sandboxed process without the
  developer's privileges). It can connect to any loopback port, send arbitrary bytes, open many
  connections, and bind any free port — including the diagnostics port before the application does.
- **A2 — a hostile web page in the developer's browser.** It can send requests to `127.0.0.1`,
  attempt DNS rebinding, and send simple cross-origin requests. It cannot set the `X-Setu-*` headers
  without a CORS preflight, and cannot read a response without a CORS grant.
- **A3 — misconfiguration.** The plugin composed into a production build, a reused session pair, a
  port shared with something else, a variable leaking into a subprocess.
- **A4 — a key-holding peer.** Any process holding the session pair: a buggy server, or a second
  application launched with the same pair against the rules. It can produce correctly signed
  responses.
- **A5 — a defective or hostile diagnostics provider.** An in-process source (M98a reader or an
  inspector source) that violates its DTO contract, whether by bug or because a third-party plugin
  replaced it.

Outside the threat model, and stated rather than implied:

- **A privileged local sniffer** (root, or `CAP_NET_RAW`). Loopback HTTP is not encrypted; such a
  party reads every byte, including the session ID. It cannot forge a MAC without the key.
- **A process running as the developer's own account.** It can read the child environment and the
  process's memory, and so the key. No local-only design can defend against its own user.
- **A remote attacker.** The listener binds `127.0.0.1` only, and remote tunnels, proxies and shared
  untrusted hosts are unsupported.

## Approved budgets

Fixed, not configurable — a configurable security bound is one more thing to set wrongly.

| Bound                                            | Value                        |
| ------------------------------------------------ | ---------------------------- |
| Bind address                                     | `127.0.0.1` only             |
| Port                                             | 1024–65535, no fallback      |
| Active listeners                                 | 1                            |
| Simultaneous connector handlers                  | 8, one reserved for verified |
| Unpaired lanes (anonymous and verify)            | 7 of the 8                   |
| Verify lane                                      | 4                            |
| Anonymous refusal budget                         | 5/s, burst 10                |
| Session budget (debited only after verification) | 20/s, burst 40               |
| Parsed header bytes                              | 8 KiB                        |
| Request body                                     | 0 bytes                      |
| Response body                                    | 256 KiB, measured as sent    |
| Events per read                                  | 128                          |
| Session lifetime                                 | 15 min default, 1 ms – 1 h   |
| Client request deadline                          | 5 s                          |
| Sequence space                                   | 1 – `MAX_SAFE_INTEGER`       |

## Threats and resolutions

Each resolution is a claim the committed-tree audit checks. "Spec" names where the design commits to
it.

| #   | Threat                                                                               | Resolution                                                                                                                                                                                                                                                                                                                            | Spec                                        |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| T1  | A1 reads diagnostics without the key.                                                | Every request carries an HMAC-SHA-256 over canonical bytes under a per-launch 32-byte key. No diagnostic byte is read before `subtle.verify` succeeds; unauthenticated refusals are a fixed, data-free shape.                                                                                                                         | Protocol §MAC input, §Response requirements |
| T2  | A2 reaches the connector from a page, directly or by DNS rebinding.                  | `Host` must be exactly `127.0.0.1:<port>`; any `Origin`, including `null`, is refused; preflight is refused and no CORS header is ever emitted; the custom headers force a preflight a page cannot pass.                                                                                                                              | Protocol §Required request headers          |
| T3  | A1 replays a captured request, or races two copies of one.                           | Strictly increasing per-session sequence, advanced in ONE synchronous gate after verification, alongside the revocation and expiry checks. No nonce cache to bound. Exhaustion ends the session rather than wrapping.                                                                                                                 | Protocol §Replay, expiry, and binding       |
| T4  | A signed response is reflected back as a request.                                    | Domain separation: the second MAC line is `request` or `response`.                                                                                                                                                                                                                                                                    | Protocol §MAC input                         |
| T5  | A response is substituted across operations, sessions, instances or requests.        | The response MAC covers session, instance, the request's own sequence, the canonical target, the status code and the SHA-256 of the exact body bytes. The client verifies before parsing anything.                                                                                                                                    | Protocol §MAC input, §Response requirements |
| T6  | A4 signs a response under an identity other than the paired instance.                | The client binds every post-pairing response to the paired instance: the `X-Setu-Instance` header must equal it, and every body carrying an `instanceId` must equal it. The MAC alone cannot, since the header is an input to it.                                                                                                     | Protocol §Response requirements (R1)        |
| T7  | Two different field sequences encode to the same MAC input.                          | Every MAC field has a grammar that excludes LF, so newline-joining is injective. A new operation's canonical target must keep that property.                                                                                                                                                                                          | This review (R2); Protocol §MAC input       |
| T8  | A1 floods the port to lock out the paired client or exhaust the connector.           | Refusals before crypto; anonymous and verify lanes capped at 7 of 8 handlers; one slot reserved for verified requests; the session budget is debited only after verification.                                                                                                                                                         | Protocol §Bounds                            |
| T9  | A1 learns session state (live, expired, bound) without the key.                      | A wrong key or wrong instance fails verification and a replay is refused by the post-MAC sequence gate; all three are a uniform `unauthorized` (a wrong session ID is distinguishable — R7). `expired` is answered only to a request whose MAC verified. After revocation the key is discarded, so later requests are `unauthorized`. | This review (R4, R7)                        |
| T10 | Request smuggling or header ambiguity past the connector's checks.                   | Zero-body policy and comma refusal in the singleton headers, both before framework mapping. The connector repeats semantic validation after mapping. No claim about raw-wire header multiplicity is made.                                                                                                                             | Protocol §Transport                         |
| T11 | The key leaks through the command line, a URL, a file, a log or a diagnostic record. | The launcher hands the pair over in the child environment only. The plugin reads no environment variable itself. The key is imported non-extractable and the raw copy zeroed. Supplied headers are never logged.                                                                                                                      | Plan §3.2; M98c for the scaffolded handoff  |
| T12 | Data is released after revocation or expiry, from a request already in flight.       | Post-await gates re-check admissibility before signing and after signing; a response built across a revocation is discarded. `revoke()` is idempotent and closes the listener on every shutdown and failed-startup path.                                                                                                              | Protocol §Revocation; Plan §3.4             |
| T13 | A3 exposes the connector unintentionally.                                            | Explicit `enabled: true` with a port and pair; no environment auto-enable; loopback-only bind; Deno only, every other runtime refuses before binding; a port conflict fails closed; never mounted on the application's listener.                                                                                                      | Protocol §Transport; Plan §3.1              |
| T14 | A1 binds the port first and impersonates the connector.                              | The client never accepts a response it cannot verify, and a failed initial pairing is terminal. The server fails closed on the conflict. The result is a failed session, never forged data.                                                                                                                                           | Plan §3.5 (R5)                              |
| T15 | A5 returns a DTO that leaks a field or breaks the client.                            | The connector re-projects every result against an exact field allowlist before serializing. The client validates the exact DTO, including vocabularies and bounds, and deep-freezes what it returns.                                                                                                                                  | Protocol §Response requirements             |
| T16 | A1 sends an oversized or never-ending response to the client (port squatting, T14).  | The client reads at most 256 KiB from the stream and cancels on overflow; `Content-Length` is not trusted. A 5-second deadline aborts the request. Redirects are refused.                                                                                                                                                             | Protocol §Response requirements; Plan §3.4  |

## Design findings

Findings this review raises against the committed design. Each is resolved here or accepted with its
reason.

| #  | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                                                                           |
| -- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 | Medium   | The plan's design treated the response MAC as sufficient identity binding. It is not: the instance header is an input to the MAC, so a key-holding peer can sign under any identity.                                                                                                                                                                                                                                                                                                      | **Fixed** in PR #370, which binds every post-pairing response header and body to the paired instance. Recorded here because the design, not only the code, was wrong.                                                                                                                                                                                                                 |
| R2 | Low      | Neither the plan nor the specification states that the MAC encoding must be injective. Today it is, because every field's grammar excludes LF — but that is a property of each grammar, not a stated rule, so a later operation could break it without contradicting any document.                                                                                                                                                                                                        | **Resolved in this review:** the rule is stated in the specification's MAC section, and the audit checks it for every current operation.                                                                                                                                                                                                                                              |
| R3 | Low      | The paired client's availability depends on the session ID staying secret. A holder of the session ID but not the key enters the verify lane and can hold its four slots with wrong-MAC requests. The session ID crosses loopback in clear, so a privileged sniffer has it, and the connector matches it with ordinary string comparison.                                                                                                                                                 | **Accepted.** Confidentiality and integrity never depend on the session ID. The parties who can read it — a privileged sniffer or the developer's own account — are outside the model and can already stop the process. A timing oracle on a 32-character comparison across loopback jitter is not a practical route to it. Constant-time comparison would be cheap defence in depth. |
| R4 | Low      | The specification lists `expired` beside `unauthorized` without saying when each is answered, so a design that answered `expired` before verifying the MAC would tell A1 that a session exists and when it ended.                                                                                                                                                                                                                                                                         | **Resolved in this review:** `expired` is answered only after a successful verification (T9), and the specification says so.                                                                                                                                                                                                                                                          |
| R5 | Low      | A1 can bind the diagnostics port before the application and deny the session (T14). The server refuses to fall back to another port, which is correct, and so cannot recover.                                                                                                                                                                                                                                                                                                             | **Accepted.** The effect is availability only, the developer sees a failed pairing rather than wrong data, and falling back to a port the client did not choose would weaken the launcher's binding of endpoint to session.                                                                                                                                                           |
| R6 | Low      | Connections are parsed by the runtime before any connector bound applies, and they consume file descriptors the parent application shares. A1 can open idle connections faster than the connector's handler caps can see.                                                                                                                                                                                                                                                                 | **Accepted.** The plan disclaims native parser resources as a runtime responsibility, and A1 has identical reach to the application's own port. The diagnostics listener adds no exposure the application did not already have.                                                                                                                                                       |
| R7 | Low      | Found by the committed-tree audit. A wrong session ID is refused before verification and debits the anonymous refusal budget, while the right session ID with a wrong MAC reaches `subtle.verify` and debits nothing. Once A1 drains that budget, a wrong candidate ID answers `429` and the right one `401`, and the verify step adds a measurable delay (about 0.09 ms on loopback). So T9's uniformity holds between wrong key, wrong instance and replay, but not for the session ID. | **Accepted.** It can only confirm a candidate, and the ID is 128 random bits, so there is nothing to confirm by guessing. Confirming it grants no data or authority, and R3 already accepts what an ID holder can do. Closing it would mean spending crypto on unauthenticated traffic, which the flood design (T8) exists to avoid.                                                  |

## Obligations for the committed-tree audit

The audit drives each of these at the real surface — the RuntimePlugin listener on a real loopback
socket, the real connector and the real native client — with a positive control beside every
negative half. Wire-level cases use a raw `Deno.connect` socket, never `fetch`, which strips or
coalesces the very headers these cases are about.

1. **Credentials.** Missing, malformed, wrong-session, wrong-key, replayed, out-of-order, stale
   after revocation, expired and cross-instance requests are each refused; a valid request is
   served. Racing two copies of one signed request yields exactly one success.
2. **Uniform refusal (T9, R4; R7 excepted).** A wrong key and a wrong instance (refused at
   verification) and a replay (refused by the post-MAC sequence gate) are indistinguishable on the
   wire. `expired` never reaches a request whose MAC did not verify.
3. **Browser and authority (T2).** Every `Origin` value including `null`, a preflight, a wrong or
   aliased `Host`, a forwarding header and a URL authority disagreeing with `Host` are refused; no
   response carries a CORS header.
4. **Framing (T10).** A body by `Content-Length`, by `Transfer-Encoding`, and a duplicate singleton
   header line are refused before mapping, over a raw socket.
5. **Canonicalization (T5, T7, R2).** Every signed request and response field is mutated one at a
   time and each mutation is refused. Every canonical target the handler accepts, across all seven
   operations, is shown to contain no LF.
6. **Floods (T8).** With the anonymous and verify lanes saturated by unpaired traffic, the paired
   client is still served. The session budget is shown not to move under unverified traffic.
7. **Revocation in flight (T12).** A revocation landing during the read, during serialization and
   during signing releases no data, and no later request is served. The listener is closed after
   `revoke()`, after `stop()`, and after a failed parent startup.
8. **Client (T6, T14, T15, T16).** Against a hostile server on the port: an unsigned body, a signed
   body under another identity, an oversized stream without `Content-Length`, a stalled response and
   a redirect are each refused, and none reaches the caller parsed.
9. **Exposure (T13).** Without the plugin, or with `enabled` absent, no socket is bound. The
   application's own port serves no `/v1/*` diagnostics route. Non-Deno runtimes refuse before
   binding.
10. **Canaries (T1, T11).** A canary key and session ID passed through the launcher handoff are
    absent from every response, refusal, log record and diagnostic record, while an approved
    diagnostic field still arrives.
11. **Bounds (Approved budgets).** Every fixed bound is exercised at and one past its limit; none
    fails open.
