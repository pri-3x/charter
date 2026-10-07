# Security Policy

Charter decides whether an AI agent's action may proceed, holds the credentials that make those
actions possible, and keeps the record that says what happened. A flaw in any of those three is a
flaw in the only thing the product is for. Reports are genuinely welcome.

## Status

Charter is pre-1.0 and should be treated as such. There is no bug bounty — this is a small project
without a budget for one. What is offered instead: a real reply from someone who can fix it, credit
in the advisory and the release notes unless you'd rather not be named, and an honest answer when
something is a known gap rather than a discovery.

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Use either:

- **GitHub private advisory** — *Security → Report a vulnerability* on this repository. Preferred,
  because it keeps the report, the fix and the disclosure in one place.
- **Email** — `security@usecharter.xyz`

Useful to include, in rough order of how much it helps:

1. What an attacker gets — a verdict they shouldn't, a credential they shouldn't hold, a ledger entry
   they can alter or suppress, or an action executed without a committed entry.
2. The smallest reproduction you have. A failing test against `npm run test:integration` is ideal;
   a `curl` sequence is fine.
3. Whether it applies to the hosted service at `usecharter.xyz`, to self-hosted deployments, or both.
4. Anything you think makes it *not* exploitable — it saves a round trip and we'd rather know.

You'll get an acknowledgement within **72 hours**. If you don't, assume it went astray and ping again
rather than assuming it was ignored.

Please don't run automated scanners against `usecharter.xyz`, test against tenants that aren't yours,
or use the public sandbox to reach systems that aren't Charter's. The sandbox exists so you can try
the product; it is not an authorization to attack third parties through it.

## Scope

**In scope**

- The gate: authority envelope evaluation, policy rule ordering, velocity limits, autonomy caps,
  hold creation and resolution. Anything that yields a verdict the policy does not justify.
- The ledger: hash-chain construction (RFC 8785 canonicalization, `entry_hash` derivation), Merkle
  checkpoints, Ed25519 signing, and the verifier. Anything that lets a record be altered, removed or
  back-dated without verification failing.
- **The core invariant** — *no verdict is returned before its ledger entry is durably committed.*
  Any path that returns a verdict without a committed entry is a vulnerability, even if the verdict
  itself is correct.
- Credential custody: AES-256-GCM sealing, the egress descriptor bound as AAD, redaction, and any
  route through which a stored secret becomes readable.
- Tenant isolation: any path where one tenant reads, writes or influences another's policies,
  credentials, holds or ledger.
- Authentication: agent keys, tenant-scoped admin keys, and the MCP endpoint at `/mcp`.
- The hosted deployment at `usecharter.xyz`, within the limits above.

**Out of scope**

- The three known limitations listed below. They're documented in the code; reporting them again is
  welcome but won't be treated as a new finding.
- Missing hardening headers, TLS configuration grades, and similar findings on the marketing pages at
  `usecharter.xyz`, where no credential or ledger data is handled.
- Denial of service through sheer volume, and anything requiring a compromised database host, stolen
  signing key, or `CHARTER_CREDENTIAL_KEY` already in the attacker's hands. Those are assumed losses,
  not defended positions — see below.
- Social engineering, physical access, and findings in third-party dependencies that aren't reachable
  through Charter's own code paths.

## What Charter does and does not claim

Knowing where the line is drawn makes it clearer what counts as a break.

**Claimed.** Every verdict is deterministic and reproducible from the policy document and the request.
Every verdict is durably recorded before it is returned. The ledger is *tamper-evident*: an altered,
inserted or removed entry makes verification fail at a known sequence number, and the verifier shares
no code with the writer, so a bug in the writer cannot silently excuse itself. In custody mode, an
agent cannot perform an action the gate refused, because the agent never holds the credential.

**Not claimed.** The ledger is tamper-*evident*, not tamper-*proof* — it proves that records changed,
it does not prevent a sufficiently privileged operator from changing them. An attacker who holds the
checkpoint signing key can sign a forged chain; an attacker holding `CHARTER_CREDENTIAL_KEY` can open
stored credentials. Those keys are the trust anchors, and protecting them is a deployment concern,
not something the code can solve for you.

In **advisory mode** (SDK `guard()`), an agent that simply does not call the gate is not gated. This
is a deliberate property of that integration pattern, not a defect — test **A4** exists to
demonstrate it, and `docs/DECISIONS.md` **D1** records the decision. Enforcement comes from custody
mode, where there is no credential to bypass the gate with.

## Known limitations

These are recorded in the source rather than papered over, and are listed here so nobody spends an
evening rediscovering them.

**DNS rebinding on egress endpoints** — `packages/gate/src/credentials/egress.ts`. A registered
`endpoint_url` using a literal IP is checked against private, loopback, link-local and metadata
ranges. A *hostname* is not resolved before the request, and resolving it wouldn't be sufficient
anyway, since the resolution used for the check need not be the one the request uses. Closing this
means pinning the resolved address and connecting to it through a custom agent. Registration is
admin-only, so the exposure is a misconfigured administrator rather than a hostile caller — but it is
a real gap.

**Policy cache divergence within the TTL** — `packages/gate/src/policy/store.ts`. The active policy
is cached per instance for `CHARTER_POLICY_CACHE_TTL_MS` (default 30s). `invalidate()` only clears
the instance that served the activation, so for up to one TTL other warm instances may still enforce
the previous version. Bounded and documented, but it means a tightened rule does not take effect
everywhere at once. Closing it properly needs `LISTEN/NOTIFY` or a per-request version check rather
than a timer.

**Trial tenants are not reaped** — the ledger is INSERT-only by design, so sandbox and trial tenants
accumulate rather than being deleted. This is a retention and cost question, not an isolation one:
each tenant's chain remains independent.

## Handling

Fixes land on `main` with a test that fails without them. Anything affecting the ledger's integrity
or tenant isolation is treated as urgent; anything that could cause a verdict to be returned without
a committed entry is treated as critical regardless of exploitability.

Coordinated disclosure is the default: a public advisory goes out once a fix is available, or after
90 days, whichever comes first. If you'd rather disclose on a different timeline, say so in the
report and it can be discussed — the 90 days is a backstop against a report going stale, not an
attempt to sit on your work.
