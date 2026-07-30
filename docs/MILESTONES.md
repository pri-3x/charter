# MILESTONES.md — build strictly in order. Each ends with its TEST_PLAN scenarios green.

> **Status (2026-07-26):** M1–M5 complete, plus two modules the original pack predated — the
> **Registry** and **Authority documents** from the Charter product overview (§5.1/§5.2) — and the
> evidence surface (attestation pack + live stream) and the Charter operator console. See PROGRESS.md
> for results, the bugs found while verifying, and DECISIONS D16–D21 for the new semantics.
>
> Order actually built: registry/authority first (the gate must enforce a grant before a UI can show
> one honestly), then the demo agent + adversarial + soak, then attestation + stream, then the front
> end, then the seven-act `npm run demo`.

## M1 — Skeleton gate + chained ledger
Tasks:
1. Monorepo scaffold (npm workspaces, tsconfig strict, vitest, eslint minimal), docker-compose
   with Postgres 16, migration runner, apply db/schema.sql as 0001_init, seed script
   (tenant acme-fintech, agent support-agent + API key printed once, principals monty/steven
   with role finance-lead, ledger_seq row).
2. `packages/shared`: RFC 8785 JCS serializer + sha256 helpers + entry types. Property tests.
3. `packages/gate`: Fastify app, bearer auth (agent key → fingerprint lookup), POST
   /v1/actions/check with a HARD-CODED interim policy (refund lte 500000 ALLOW; delete_record
   DENY; unknown DENY), transactional seq+chain+insert per DECISIONS D4, idempotency (D10),
   GET /healthz, GET /v1/ledger (admin key).
4. Latency: log per-request evaluation+commit ms.
Acceptance: S1, S9, S11, S16, S18, S19 pass (script them now even though the policy is interim).

## M2 — Real policy engine
Tasks:
1. YAML policy schema (zod), parser, POST /v1/policies + activate (+ POLICY_ACTIVATED entry,
   cache invalidation), seed policies/example.acme.yaml as version 1.
2. Evaluator per SPEC 3.3 with rule_trace; matchers eq/gt/gte/lt/lte/in; autonomy cap.
3. Stateful limits: count + sum over limit_counters (1-min buckets, window sum via SQL), consumed
   in the verdict transaction (D8).
4. Wire evaluator into check; remove interim policy.
Acceptance: S1–S4, S9–S14 (S13 is the anti-structuring sum limit — get this exact), S16, S17.

## M3 — Approvals + kill switch
Tasks:
1. holds creation on ESCALATE inside the verdict transaction; GET /v1/holds/:id; decision
   endpoint with self-approval 403 (S8 semantics per API.md).
2. `packages/approvals`: grammy bot; poll for new PENDING holds; context packet message with
   velocity readout; inline buttons; telegram user → principal mapping; APPROVAL ledger entries;
   message edit after decision; 30s expiry sweeper → EXPIRED (fail closed).
3. POST /v1/agents/:id/suspend + gate check + AGENT_SUSPENDED entry.
4. SDK (`packages/sdk`): MandateClient, guard(), hold polling, typed errors, result reporting.
Acceptance: S5–S8, S15; re-run S1–S4.
Manual check: real Telegram round-trip with your own bot token and chat.

## M4 — Merkle checkpoints + independent verifier
Tasks:
1. Checkpoint worker in gate process (setInterval; crash-safe query per SPEC 4.3), Ed25519 keygen
   script (writes PEM pair; public key for verifier), anchors.log appender.
2. GET /v1/ledger/checkpoints and /v1/ledger/proof/:entry_id (Merkle path builder).
3. `packages/verifier`: independent JCS+hash+Merkle+sig reimplementation, streaming row scan,
   report + exit codes, --anchors comparison. NO imports from other packages.
4. `npm run tamper-demo`: scripted psql session that (a) disables the trigger, (b) edits one
   amount (T1), (c) runs verifier → FAIL @ seq; then restores from backup and runs T3 (forged
   insert) → checkpoint mismatch. Print a clean narrative.
Acceptance: T1–T6 all detected with correct localization; verifier 1M-entry synthetic benchmark
< 60s (generate synthetic entries with a script).

## M5 — Demo agent + adversarial + soak + demo script
Tasks:
1. `packages/demo-agent`: Anthropic tool-use loop, guarded tools, fixture orders, scenario
   driver (--scenario S1..S20 / A1 / A2), --interactive mode.
2. Adversarial: A1 prompt-injection fixture conversation; A2 structuring conversation; A3
   documented attempt (update_record with sneaky params) — record observed behavior in
   PROGRESS.md; A4 bypass demonstration (a script that calls the raw tool fn directly) with a
   README note on why Pattern B fixes it.
3. S20 soak: 1,000 checks at 50/sec (autocannon or hand-rolled), assert p50/p99 budgets and
   chain integrity after.
4. `npm run demo`: the 5-minute script — seed, small refund ALLOW, delete DENY, big refund
   ESCALATE → Telegram approve → OUTCOME, then tamper-demo, then verifier OK on clean DB.
Acceptance: entire TEST_PLAN green; demo runs start-to-finish unattended except the Telegram tap.

## M6 — Registry + Authority + evidence surface + console  ✅ (added after the product overview)
Tasks (all done — see PROGRESS.md):
1. Migration `0002`: charter fields on agents (owner FK, department, approver chain, mandatory
   expiry), immutable versioned `authorities`, four new ledger kinds.
2. Authority envelope evaluated inside the verdict transaction, before/around the policy; standing
   failures short-circuit, envelope failures still record the policy's view (D18).
3. Registry endpoints (charter, list, grant, revoke, reinstate), each write a ledger entry.
4. `GET /v1/attestation` (JSON + printable HTML, reproducible pack hash) and `GET /v1/stream` (SSE).
5. Charter console: Registry · Gate · Approvals · Evidence · Attestation · Settings, with in-browser
   chain + Merkle recomputation as a third independent implementation.
Acceptance: S21–S24 green, S1–S20 still green, attestation + stream covered by integration tests.

## Next (not built)
- **Pattern B — credential-custody proxy.** The one change that turns "every call through the SDK is
  authorized" into "no call can happen any other way". A4 shows the bypass leaves no ledger trace;
  this is the fix, and it is the moat (tool credentials live inside Charter).
- **MCP gateway.** The tool boundary the market is standardizing on; a drop-in enforcement point that
  does not ask a team to wrap every tool by hand.
- **Bypass detection** in the meantime: reconcile tool-side counters against the ledger and alarm on
  the gap, so an unguarded path is at least *visible* rather than silent.
- Encrypted params (D12 → v1), WORM/TSA anchoring (D5 → v1), Slack approvals, multi-tenant hardening.

## Working agreement for Claude Code
- One milestone per session/branch. Do not start M(n+1) with M(n) red.
- After each milestone append to PROGRESS.md: what was built, scenario results table, any
  deviation from DECISIONS.md (with reason), and open questions for the human.
- If a spec ambiguity blocks you: choose the fail-closed interpretation, implement, and flag it
  in PROGRESS.md — do not silently choose the permissive reading.
