# SPEC.md — Charter POC technical specification

> **Naming.** **Charter** everywhere, including the protocol constants: the genesis string
> `CHARTER_GENESIS:<tenant>`, the DB roles `charter_gate`/`charter_verifier`, the `@charter/*`
> package scope, the `CHARTER_*` env vars and the `charter` database. Renaming the genesis string
> re-bases every chain — that cost was paid once, on purpose, at POC stage (DECISIONS **D19a**).

Charter = registry of chartered agents + versioned authority grants + policy enforcement point
("gate") + tamper-evident audit ledger + human approval flow.
An agent proposes an action; the gate authenticates it, evaluates versioned policy, writes the
verdict to an append-only hash-chained ledger in the same transaction, and returns
ALLOW / DENY / ESCALATE. Escalations page a human on Telegram; approvals are ledger entries too.
A background worker seals the ledger into signed Merkle checkpoints. An independent verifier CLI
can prove the ledger untampered — or name the exact record that was.

## 1. Actors and objects
- **Tenant**: customer org. All data tenant-scoped. POC ships one seeded tenant `acme-fintech`.
- **Agent**: registered AI agent with an API key (store only SHA-256 fingerprint), an
  allowed_tools scope, and a max_autonomy cap (ALLOW | ESCALATE).
- **Principal**: human/service the agent acts for; also the identity approvers map to.
  Fields include telegram_user_id for approver mapping.
- **Action**: `{ tool: string, params: object, principal: string, context?: { reasoning?: string,
  conversation_ref?: string } }`.
- **Policy**: versioned YAML (see policies/example.acme.yaml and §3).
- **Charter**: the registry entry on an agent — owner principal (a real human), department, purpose,
  approver chain, and a **mandatory expiry**. See §1.5.
- **Authority**: a versioned grant document delegating specific power to one agent. See §1.6.
- **Ledger entry kinds**: VERDICT, APPROVAL, OUTCOME, POLICY_ACTIVATED, AGENT_SUSPENDED,
  AGENT_REGISTERED, AGENT_REINSTATED, AUTHORITY_GRANTED, AUTHORITY_REVOKED.

### 1.5 The Registry (Charter §5.1)
Every agent is chartered before it can act. `agents` carries `owner_principal` (FK to `principals` —
accountability is a named human, never a team label), `department`, `purpose`, `approver_chain` and
`expires_at`. Registration writes an **AGENT_REGISTERED** entry; the API key is returned exactly once
and only its SHA-256 fingerprint is stored.

Stored status is ACTIVE | SUSPENDED | REVOKED. **EXPIRED is derived** from `expires_at` at read time
and is never stored, so a charter cannot outlive its date because a sweeper failed to run. The
registry's derived view (`charter_status`) is what operators and reports see.

### 1.6 The Authority Document (Charter §5.2)
Authority is a first-class versioned object, not metadata on the agent. Each grant records: `ref`
(human reference, e.g. `auth_2026_0071`), `version`, the **named grantor**, a validity window, an
optional budget (`budget_minor` + currency + window minutes), `allowed_tools`, `forbidden_ops`, and
the canonical document plus its `doc_hash` (SHA-256 over JCS of the document).

Grants are immutable. Issuing a new grant marks the previous one SUPERSEDED (a new version, never an
edit); revocation flips status to REVOKED and stamps the revoking entry. Both write ledger entries
(**AUTHORITY_GRANTED** / **AUTHORITY_REVOKED**), so "which grant was this verdict decided under" is
answerable from the chain alone. At most one ACTIVE grant per agent (enforced by a partial unique
index).

## 2. Runtime flow (per action)
1. SDK sends POST /v1/actions/check with Idempotency-Key.
2. Gate authenticates API key → agent row (status must be ACTIVE; else DENY "agent suspended").
3. Load active policy version for tenant (in-memory cache, invalidated on activation).
3a. **Authority envelope (§3.5)** — inside the verdict transaction, load the charter + live grant and
   evaluate the envelope. A *standing* failure (no charter, no grant, expired, revoked) short-circuits
   to DENY with an empty rule_trace: there is nothing to evaluate. An *envelope* failure (forbidden
   operation, tool not granted, budget exceeded, currency mismatch) still evaluates the policy, so the
   evidence records both views.
4. Evaluate (§3.3) → verdict + rule_trace, then apply the authority decision, which can only tighten.
5. In ONE transaction: assign per-tenant seq, compute prev_hash, build entry, compute entry_hash
   (RFC 8785 JCS, see DECISIONS D3/D4), INSERT ledger entry; if ESCALATE also INSERT hold;
   if a stateful limit was consumed, upsert limit_counters. COMMIT.
6. Respond `{ verdict, entry_id, reason?, rule_id?, hold_id? }`.
7. If ESCALATE: approvals service sends the context packet to Telegram. Human taps
   Approve/Reject → APPROVAL ledger entry (same hashing rules) linking the original entry_id →
   hold resolved. SDK polls GET /v1/holds/:id (2s interval) until APPROVED/REJECTED/EXPIRED.
8. After executing an allowed action, SDK sends POST /v1/actions/:entry_id/result → OUTCOME entry.
9. Checkpoint worker (§4.3) seals batches; verifier (§5) checks everything.

## 3. Policy engine
### 3.1 Document shape (YAML)
```yaml
version: <int, server-assigned on activation>
tenant: acme-fintech
defaults:
  unknown_tool: DENY
  unknown_agent: DENY
agents:
  support-agent:
    allowed_tools: [refund, send_email, lookup_order, update_record]
    max_autonomy: ALLOW          # or ESCALATE
rules:
  - id: R1-refund-small
    when: { tool: refund, params.amount: { lte: 500000 } }   # paise
    verdict: ALLOW
  - id: R2-refund-large
    when: { tool: refund, params.amount: { gt: 500000 } }
    verdict: ESCALATE
    approvers: [role:finance-lead]
    ttl_minutes: 240
  - id: R3-no-deletes
    when: { tool: delete_record }
    verdict: DENY
    reason: "Agents may never delete records."
  - id: R4-email-rate
    when: { tool: send_email }
    limit: { window_minutes: 60, max_count: 20, key: agent }
    verdict_on_breach: DENY
  - id: R5-refund-velocity
    when: { tool: refund }
    limit: { window_minutes: 1440, sum_param: params.amount, max_sum: 5000000, key: principal }
    verdict_on_breach: ESCALATE
    approvers: [role:finance-lead]
    ttl_minutes: 240
```
### 3.2 `when` matchers
Field paths: `tool`, `params.<dot.path>`. Operators: `eq` (default when a scalar is given),
`gt`, `gte`, `lt`, `lte`, `in` (array). Multiple conditions in one `when` are AND.
Missing param referenced by a matcher ⇒ the rule does not match (and note it in rule_trace).

### 3.3 Evaluation algorithm
```
if agent.status == SUSPENDED -> DENY (reason: agent suspended)          [trace: scope]
if tool not in agent.allowed_tools -> DENY (reason: outside scope)      [trace: scope]
for rule in rules (document order):
    if when matches:
        if rule has limit:
            consumed = current window usage for key
            breach = (count+1 > max_count) or (sum + value > max_sum)
            verdict = breach ? verdict_on_breach : (rule.verdict ?? ALLOW)
        else:
            verdict = rule.verdict
        break
else: verdict = defaults.unknown_tool
apply autonomy cap: if agent.max_autonomy == ESCALATE and verdict == ALLOW -> ESCALATE
  (cap-induced escalations use tenant default approvers, ttl 240)
```
rule_trace records every rule evaluated: `{rule_id, matched, why}` plus final
`{scope_ok, cap_applied}` flags.

### 3.4 Lifecycle
POST /v1/policies validates YAML (zod schema) and stores a draft; activation assigns
version = max+1, flips previous active to retired, writes POLICY_ACTIVATED entry with doc SHA-256.
Simulation/shadow mode is OUT of POC scope (mentioned for v1; do not build).

### 3.5 Authority envelope (evaluated before/around the policy)
Checks in order, each recorded in the VERDICT payload's `authority.checks[]` whether it passed or not:

| # | Check | Failure verdict | Stage |
|---|---|---|---|
| 1 | charter status is not REVOKED | DENY `charter.revoked` | standing |
| 2 | charter not past `expires_at` | DENY `charter.expired` | standing |
| 3 | a live grant exists | DENY `authority.missing` | standing |
| 4 | now inside the grant's window | DENY `authority.not_yet_valid` / `authority.expired` | standing |
| 5 | tool ∉ `forbidden_ops` | DENY `authority.forbidden_operation` | envelope |
| 6 | tool ∈ `allowed_tools` (when non-empty) | DENY `authority.tool_not_granted` | envelope |
| 7 | action currency matches the grant's | DENY `authority.currency_mismatch` | envelope |
| 8 | window spend + amount ≤ `budget_minor` | DENY `authority.budget_exceeded` | envelope |

Rules that follow from this:
- **The grant can only tighten.** If the policy already denies, its `rule_id` is kept (the authority
  finding stays in the trace); the authority never turns a DENY into anything weaker.
- **Exceeding the grant is a DENY, not an escalation** (D17): an approver may not hand out authority
  nobody granted them. Escalation thresholds belong in policy, boundaries belong in the grant.
- **Budget spend reuses the policy limit machinery** (`limit_counters` with `rule_id =
  authority:<id>`), so consumption follows D8 exactly: ALLOW consumes, DENY never consumes, and an
  ESCALATE's spend is deferred until the approval commits.
- A grant with `budget_minor = null` sets no ceiling; tools carrying no `params.amount` consume nothing.

## 4. Ledger
### 4.1 Entry payload (stored in payload_jsonb, hashed per D3)
```json
{
  "seq": 42, "entry_id": "01J...", "ts": "2026-07-12T10:41:22.184Z",
  "tenant": "acme-fintech", "kind": "VERDICT",
  "agent": { "id": "support-agent", "key_fingerprint": "sha256:..." },
  "principal": "user:rahul@acme.co",
  "action": { "tool": "refund", "params": { "order_id": "O-9912", "amount": 1200000 },
              "params_hash": "sha256:..." },
  "context": { "reasoning": "customer reported duplicate charge" },
  "policy": { "version": 7, "doc_hash": "sha256:..." },
  "rule_trace": [ {"rule_id":"R1-refund-small","matched":false,"why":"amount>500000"},
                  {"rule_id":"R2-refund-large","matched":true,"why":"amount>500000"} ],
  "verdict": "ESCALATE",
  "hold": { "id": "01J...", "approvers": ["role:finance-lead"], "ttl_minutes": 240 },
  "prev_hash": "sha256:...",
  "entry_hash": "sha256:..."
}
```
APPROVAL entries carry `{ decision: APPROVED|REJECTED|EXPIRED, hold_id, verdict_entry_id,
decided_by: principal|null, channel: telegram|system }`. OUTCOME entries carry
`{ verdict_entry_id, status: SUCCESS|FAILURE, result_hash }`.
All kinds share the seq/prev_hash/entry_hash chain fields.

### 4.2 Chain rules
See DECISIONS D4. The DB stores seq, prev_hash, entry_hash as columns AND inside payload_jsonb;
the verifier checks column↔payload consistency too.

### 4.3 Checkpoint worker
Every 5 min or 1,000 new entries: build Merkle over entry_hash leaves (seq order) per D5, sign,
INSERT checkpoints row, append signed JSON line to `anchors.log`, log at info. Crash-safe: the
worker selects entries with seq > last checkpoint's seq_to.

## 5. Verifier CLI (`packages/verifier`)
`charter-verify --tenant acme-fintech [--from-seq N]` with read-only DB creds. Steps:
1. Recompute entry_hash for every entry from payload (own JCS impl) — mismatch ⇒ FAIL @ seq.
2. Walk chain: seq gaps, prev_hash continuity, column/payload consistency — break ⇒ FAIL @ seq.
3. Rebuild each checkpoint's Merkle root; verify Ed25519 signature (public key via env/file);
   compare against anchors.log if provided (--anchors path).
4. Print report: entries checked, checkpoints verified, OK/FAIL with first-failure seq. Exit 0/1.
Performance target: 1M entries < 60s (stream rows, no ORM).

## 6. Approvals service (`packages/approvals`)
Telegram bot (grammy, long polling). On hold creation (poll the DB every 2s for POC — no queue):
send the context packet message with inline Approve/Reject buttons to the tenant's approver chat.
Packet: tool + human-readable amount, agent, principal, matched rule + reason, reasoning excerpt,
current velocity usage for the relevant counter ("today ₹43,500 of ₹50,000"). Button callback:
map telegram user → principal; reject self-approval; write APPROVAL entry + resolve hold; edit
the message to show the outcome and who decided. Sweeper: every 30s expire past-TTL holds →
APPROVAL entry with decision EXPIRED (decided_by null) → hold status EXPIRED.

## 7. SDK (`packages/sdk`)
```ts
const charter = new CharterClient({ baseUrl, apiKey, agentId: "support-agent" });
const refund = charter.guard("refund", realRefundFn, { principal: () => currentUser });
await refund({ order_id: "O-9912", amount: 1200000 });
```
guard(): calls check (with generated Idempotency-Key + reasoning from options); ALLOW → run fn,
then fire-and-forget result report; DENY → throw PolicyDeniedError{rule_id, reason};
ESCALATE → poll hold until resolution or ttl → run fn on APPROVED else throw
HoldRejectedError/HoldExpiredError. Also expose low-level client.check()/client.reportResult().

## 8. Demo agent (`packages/demo-agent`)
Anthropic tool-use loop, model claude-sonnet-4-6. System prompt: customer-support agent for a
payments company; includes the (deliberately soft) instruction "refunds above ₹5,000 should get
approval" so tests A1/A2 can show prompt-vs-gate divergence. Tools (all guarded via SDK):
refund, send_email, lookup_order (returns fixture orders), update_record. delete_record exists
as a raw tool the model can request but policy denies. CLI: `npm run demo -- --scenario S13`
drives scripted conversations; `--interactive` for freeform. Needs ANTHROPIC_API_KEY in env.

## 9. Non-functional (POC)
Added latency p50 ≤ 50ms / p99 ≤ 150ms on localhost (measure in S20 soak). Single node. Fail
closed on any dependency failure. No PII in logs beyond principal identifiers.

## 10. Out of scope for POC (do not build)
Web dashboard (a `GET /v1/ledger` JSON endpoint is enough), multi-tenant onboarding, SSO,
proxy/credential custody, policy shadow mode, params encryption, Redis, webhooks, quorum
approvals, un-suspend flow.
