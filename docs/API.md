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
Body: `{ "yaml": "<policy document>" }` → validates, stores draft →
`{ "draft_id", "parsed": {...} }`.
## POST /v1/policies/:draft_id/activate   (admin)
→ `{ "version": 8, "doc_hash": "sha256:...", "activated_entry_id": "01J..." }`

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

## GET /healthz
→ `{ "ok": true, "db": true, "active_policy_version": 7 }` — returns 503 with ok:false if the
DB is unreachable (used by S18).
