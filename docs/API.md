# API.md — HTTP contract (all JSON; auth: `Authorization: Bearer <agent-or-admin-key>`)

Key types: agent keys (scoped to one agent) for /actions and /holds reads; an admin key
(env `CHARTER_ADMIN_KEY`) for /policies, /ledger, /agents. 401 on bad key. 400 on zod failure
with `{error, details}`. DENY is 200, not an error (DECISIONS D14).

## POST /v1/actions/check   (agent key; header `Idempotency-Key` required)
Request:
```json
{ "tool": "refund",
  "params": { "order_id": "O-9912", "amount": 1200000, "currency": "INR" },
  "principal": "user:rahul@acme.co",
  "context": { "reasoning": "duplicate charge confirmed", "conversation_ref": "conv:88" } }
```
Response 200 (one of):
```json
{ "verdict": "ALLOW", "entry_id": "01J...", "rule_id": "R1-refund-small" }
{ "verdict": "DENY",  "entry_id": "01J...", "rule_id": "R3-no-deletes",
  "reason": "Agents may never delete records." }
{ "verdict": "ESCALATE", "entry_id": "01J...", "rule_id": "R2-refund-large",
  "hold_id": "01J...", "ttl_minutes": 240 }
```
Replay with same Idempotency-Key ⇒ identical body, header `Idempotency-Replayed: true`.

## POST /v1/actions/:entry_id/result   (agent key)
`{ "status": "SUCCESS" | "FAILURE", "result_hash": "sha256:..." }` → 200
`{ "outcome_entry_id": "01J..." }`. 404 if entry_id unknown/not a VERDICT/not this agent's.
409 if a result was already reported.

## GET /v1/holds/:hold_id   (agent key that created it, or admin)
→ `{ "hold_id", "status": "PENDING|APPROVED|REJECTED|EXPIRED", "decided_by": "user:...|null",
     "decided_at": "...|null", "verdict_entry_id" }`

## POST /v1/holds/:hold_id/decision   (internal; approvals service uses admin key)
`{ "decision": "APPROVED"|"REJECTED", "decided_by_principal": "user:monty@acme.co",
   "channel": "telegram" }`
→ 200 with hold; 409 if already resolved; 403 if decided_by == initiating principal
(self-approval) — the refusal is also written as a ledger-visible event in the APPROVAL entry
attempt log (kind APPROVAL, decision REJECTED_SELF is NOT used; instead respond 403 and write
nothing to the chain except an app log — keep chain semantics simple; test S8 asserts the 403
and that hold stays PENDING).

## POST /v1/policies   (admin)
Body: `{ "yaml": "<policy document>" }` → validates, checks coverage, stores draft →
`{ "draft_id", "parsed": {...}, "coverage": { "gaps": [...], "skipped": [...] } }`.

`coverage` reports action bands no *verdict* rule covers, with the verdict the gate would actually
return for them: `{ agent, tool, param, from, to, band, verdict, decided_by }`. Gaps that land on
DENY or ESCALATE are informational — that is the fail-closed direction. `skipped` names the
agent/tool pairs the analysis could not decide exactly, with the reason, so an unanalysable policy
is visibly unanalysed rather than silently passed.

**400** when a gap would be **ALLOWED** — an uncovered band that a `limit` guard answers with its
non-breach verdict, which under SPEC 3.3 is `rule.verdict ?? ALLOW`. Body:
`{ "error": "...", "coverage_gaps": [ ... ] }`. A limit rule is meant to cap what is already
permitted, never to permit it, so this is refused rather than warned about.

## POST /v1/policies/:draft_id/activate   (admin)
→ `{ "version": 8, "doc_hash": "sha256:...", "activated_entry_id": "01J..." }`
Re-runs the coverage check against the stored draft and returns the same **400** on a fail-open
policy — activation is the moment the policy starts deciding, so it is re-checked there even though
`POST /v1/policies` already refused it.

## GET /v1/ledger?tenant=...&kind=&tool=&verdict=&from_seq=&limit=   (admin)
→ `{ "entries": [ <full payloads> ], "next_from_seq": 123 }` (seq ascending, limit ≤ 500)

## GET /v1/ledger/checkpoints   (admin)
→ `{ "checkpoints": [ { "id","seq_from","seq_to","merkle_root","signature","created_at" } ] }`

## GET /v1/ledger/proof/:entry_id   (admin)
→ `{ "entry_hash", "checkpoint_id", "merkle_path": [ {"hash","side":"L|R"} ], "merkle_root",
     "signature" }`  — enough for third-party inclusion verification. 404 if not yet checkpointed.

## POST /v1/agents/:agent_id/suspend   (admin)
→ `{ "status": "SUSPENDED", "entry_id": "01J..." }` (AGENT_SUSPENDED ledger entry)

## POST /v1/agents/:agent_id/reinstate   (admin)   — D20
`{ "by_principal": "user:monty@acme.co" }` → `{ "status": "ACTIVE", "entry_id": "01J..." }`
(AGENT_REINSTATED entry). 409 if the agent is already ACTIVE.

# Registry (Charter §5.1) — all admin key; `?tenant=` defaults to the seeded tenant

## GET /v1/agents   (admin)
→ `{ "agents": [ { "id", "name", "status", "charter_status": "ACTIVE|EXPIRED|SUSPENDED|REVOKED",
     "owner_principal", "owner_name", "department", "purpose", "approver_chain": [],
     "max_autonomy", "expires_at", "registered_at", "days_until_expiry",
     "authority": { …the live grant, or null }, "spend_window_minor", "action_count" } ] }`
`charter_status` is DERIVED from `expires_at` (D16) — `status` is what is stored.

## GET /v1/agents/:agent_id   (admin)
→ `{ "agent": {…one card…}, "authorities": [ …every grant, newest version first… ] }`

## POST /v1/agents   (admin)
`{ "id": "kyc-agent", "name", "owner_principal", "department", "purpose"?,
   "approver_chain"?: [], "expires_at": ISO8601, "max_autonomy"?: "ALLOW"|"ESCALATE" }`
→ **201** `{ "agent_id", "api_key", "entry_id", "note" }` — the key is shown exactly once; only its
fingerprint is stored. Writes AGENT_REGISTERED. 400 unknown owner / missing expiry, 409 duplicate id.
A newly chartered agent holds no authority, so every action it attempts is denied until a grant
exists (`authority.missing`).

## POST /v1/agents/:agent_id/authorities   (admin)
`{ "grantor_principal", "valid_from": ISO, "valid_until": ISO, "budget_minor": int|null,
   "budget_currency"?: "INR", "budget_window_minutes"?: 1440,
   "allowed_tools": [], "forbidden_ops": [], "ref"? }`
→ **201** `{ "authority_id", "ref", "version", "doc_hash", "entry_id" }`. Supersedes the live grant
and writes AUTHORITY_GRANTED carrying the full grant document. 400 if `valid_until` ≤ `valid_from` or
a tool appears in both `allowed_tools` and `forbidden_ops`.

## POST /v1/authorities/:authority_id/revoke   (admin)
`{ "by_principal", "reason"? }` → `{ "status": "REVOKED", "agent_id", "entry_id" }`
(AUTHORITY_REVOKED). 409 if the grant is not ACTIVE. The agent is then denied everything.

# Evidence surface

## GET /v1/attestation?tenant=&from=&to=&agent_id=&format=json|html   (admin)
`from`/`to` are ISO 8601 and default to the last 30 days; an unparseable or inverted period is 400.
JSON → `{ pack_type, pack_version, header, registry, enforcement, maker_checker,
evidence_integrity, control_mapping, limitations, pack_hash_covers, pack_hash }`.
`pack_hash` is SHA-256 over JCS of the pack with `pack_hash` and `header.generated_at` absent, so the
same period reproduces the same hash. `format=html` returns a self-contained printable report
(no external assets) with the pack hash in its footer.

## GET /v1/stream?tenant=&from_seq=   (admin)
`text/event-stream`. One `event: entry` per new ledger row (`data:` = the full payload), a
`: heartbeat` comment every 15s, `from_seq` inclusive. Poll-based tail; batches are capped so a
backlog cannot flood the socket. An admin key must travel in the `Authorization` header, so browser
clients consume this with `fetch` + a stream reader rather than `EventSource`.

## Public demo endpoints (no credential)

Three narrow, rate-limited endpoints that exist so the hosted landing page can show real verdicts to
anonymous visitors. They do **not** widen the API: each one re-enters an existing route via
`app.inject()` with the credential and the parameters pinned server-side, so a demo call goes through
the same auth, idempotency, policy evaluation and ledger commit as any other. All three share one
per-IP token bucket (20 burst, 0.5/s refill) — a courtesy limit, not a security boundary; the real
containment is that nothing about the request is caller-controlled beyond a case index.

The alternative would have been publishing `/v1/dev/credentials`, which hands out the admin key and
every agent key. It stays loopback-only and refuses under `NODE_ENV=production`.

### POST /v1/demo/decide
Body: `{ "case": <integer 0..6> }` — an index into a fixed list of seven canned actions. Caller
params are ignored entirely; the gate builds them.
→ `{ txt, tool, rupees, verdict, rule_id, entry_id, latency_ms }`
- 400 — `case` is not an integer in range
- 429 — bucket empty
- 502 — the underlying `/v1/actions/check` did not return a verdict (fail closed, never dressed up)
- 503 — `CHARTER_DEMO_AGENT_KEY` is unset on this deployment

### GET /v1/demo/artefacts
→ `{ chain: [{ entry_hash }], checkpoints: [{ seq_from, seq_to, merkle_root, signature }], counts: { ALLOW, DENY, ESCALATE }, entry_count }`

Only the fields the ASCII panels sample. No payloads, no principals, no rule detail — so it cannot
become a back door onto ledger contents. Reading the ledger itself still needs the admin key.

### GET /v1/demo/attestation
→ `text/html` — `/v1/attestation` with the tenant pinned to the demo tenant, the window left at its
default last-30-days, and `format=html`. HTML only: the JSON form is the machine artefact and stays
behind the admin key. 429 / 502 as above.

## GET /healthz
→ `{ "ok": true, "db": true, "active_policy_version": 7 }` — returns 503 with ok:false if the
DB is unreachable (used by S18).

# Credential custody — Pattern B (SPEC §7, D1)

Under Pattern A the agent holds the tool function and therefore its key, so the gate is advisory:
TEST_PLAN A4 shows an agent that never calls Charter is not governed by it. Pattern B moves the
secret behind the gate. The agent is given a tool NAME; Charter evaluates the action through the
same `/v1/actions/check` path and makes the outbound call itself. All of these 503 when
`CHARTER_CREDENTIAL_KEY` is unset. Pattern A is unchanged and still supported.

## POST /v1/credentials   (admin)
`{ tenant?, tool, endpoint_url, method?, auth_scheme, auth_header?, secret, by_principal }`
→ `{ tool, key_fingerprint, rotated, entry_id }` — the secret is never echoed back, on this or any
other response. Re-registering the same tool rotates in place (one active credential per tool, so
"which key signed this call?" is never ambiguous); the ledger records the rotation.

`auth_scheme` is `bearer` | `basic` | `header` (the last requires `auth_header`). The endpoint is
validated at registration: https only (http for loopback in dev), no embedded credentials, and
never a loopback, private, CGNAT or link-local address.

The secret is sealed with AES-256-GCM, with the egress descriptor bound in as additional
authenticated data — so editing `endpoint_url` in the database does not redirect the credential, it
destroys it. Writes a `CREDENTIAL_REGISTERED` entry carrying the fingerprint, never the secret.

## GET /v1/credentials?tenant=   (admin)
→ `{ credentials: [ { tool, endpoint_url, method, auth_scheme, auth_header?, key_fingerprint,
status } ] }`. Descriptors only — there is no endpoint that returns a secret.

## POST /v1/credentials/:tool/revoke   (admin)
`{ by_principal }` → `{ tool, status: "REVOKED", entry_id }` (`CREDENTIAL_REVOKED`). Takes effect on
the next call, not at a cache expiry. 404 if no active credential.

## POST /v1/proxy/:tool   (agent, Idempotency-Key required)
`{ params, principal, context? }` → the verdict, and on ALLOW the call has already happened:
`{ verdict: "ALLOW", entry_id, outcome_entry_id, rule_id, tool_status, tool_response }`.
DENY and ESCALATE return the verdict and the credential is never touched.

Deliberately absent from the body: url, method, headers. The caller names a tool; an admin decided
long ago what that means. Otherwise this is an SSRF proxy that attaches production credentials to
whatever it is pointed at.

The gate writes the `OUTCOME` itself (`via: "proxy"`), with the upstream's reply under `egress` —
under Pattern B the gate is the only party that knows what actually happened, so the agent cannot
mis-report it.

## POST /v1/proxy/resume   (agent)
`{ hold_id }` → same shape as above, once a human has APPROVED the hold.

Takes a hold id and **nothing else**: the params are replayed from the immutable verdict entry, so
an approval for ₹500 cannot be spent as ₹500,000. 409 if the hold is not APPROVED (PENDING
included) or if the approval was already executed; 403 if it belongs to another agent.

# MCP gateway (M8)

Charter as an MCP server, so an agent is governed by changing a config block rather than wrapping
every tool by hand. `tools/call` re-enters `POST /v1/proxy/:tool` in process: the same registry
check, authority check, policy evaluation, limit counters, hold creation, ledger commit and
credential custody as any other call. There is one implementation of "may this happen"; this is a
second doorway onto it, not a second opinion.

## POST /mcp   (agent key as bearer)
JSON-RPC 2.0 over streamable HTTP, request/response only — no SSE, no session store. A single
request returns a single response; a batch returns an array; notifications return **202** with no
body. `GET /mcp` returns **405**: Charter never initiates a stream.

Client configuration is one block:

```json
{ "mcpServers": { "charter": { "url": "https://usecharter.xyz/mcp",
                               "headers": { "Authorization": "Bearer chr_..." } } } }
```

**`initialize`** — negotiates the protocol version (the client's if supported, else the newest
Charter speaks) and returns instructions telling the model that a refusal is a decision, not a fault.

**`tools/list`** — the tools this agent may call: registered with an ACTIVE credential, inside its
authority's `allowed_tools`, not in `forbidden_ops`, and carrying an `input_schema`. A tool without
a schema is withheld rather than advertised — a tool a model cannot call correctly produces a denied
action and a confused agent, which is worse than a shorter list. `charter_await_approval` is
appended when anything is advertised.

**`tools/call`** — the verdict, shaped for a model:

| Verdict | Returned as |
|---|---|
| ALLOW | the upstream response, `_meta.charter.entry_id` alongside |
| DENY | `isError: true`, the reason and rule id, and "do not retry it unchanged" |
| ESCALATE | `isError: true`, the hold id, and "do not retry — a second attempt creates a second request" |

DENY and ESCALATE are tool **results**, not JSON-RPC errors: the request was well-formed, the answer
is no, and the model needs the reason in context so it can tell the user the truth.

**`charter_await_approval`** — `{ hold_id }`. Answers immediately with PENDING / REJECTED / EXPIRED,
or executes an APPROVED hold through `/v1/proxy/resume`, where the params come from the ledger entry.
An approval is for what was approved; the model cannot substitute an amount after the fact.

## Registering a tool for MCP
`POST /v1/credentials` gains three optional fields — `title`, `description`, `input_schema`
(JSON Schema, forwarded verbatim). Without `input_schema` the tool still works over `/v1/proxy` and
is simply not advertised. `GET /v1/credentials` reports `mcp: "advertised"` or
`"hidden (no input_schema registered)"` per tool. Rotating a secret does not clear the descriptors.
