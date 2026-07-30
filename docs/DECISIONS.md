# DECISIONS.md — resolved. Do not re-open during the POC.

D1. **Integration pattern for POC = SDK check (Pattern A).** The SDK calls the gate and honors
the verdict. The proxy/credential-custody tier (Pattern B) is v1, not POC. Test A4 exists to
demonstrate Pattern A's known limit — do not try to "fix" A4 in the POC.

D2. **Verdicts are exactly three:** ALLOW | DENY | ESCALATE. No "warn", no "allow-with-log"
(everything is logged anyway).

D3. **Canonicalization = RFC 8785 JCS.** entry_hash = SHA-256 over the JCS serialization of the
entry object with the `entry_hash` field absent. Key ordering, number formatting, and string
escaping follow RFC 8785 exactly. Write property tests: serialize→parse→serialize is stable;
key order independence; unicode strings. This is the most correctness-critical code in the repo.

D4. **Hash chain:** per-tenant. `prev_hash` of entry with seq N = `entry_hash` of seq N-1.
Genesis: prev_hash = SHA-256 of the UTF-8 string `MANDATE_GENESIS:<tenant_id>`.
`seq` is a per-tenant monotonic integer assigned inside the insert transaction
(SELECT ... FOR UPDATE on a per-tenant counter row — simple and correct at POC scale).

D5. **Merkle checkpoints:** worker batches un-checkpointed entries every 5 minutes OR when 1,000
accumulate, whichever first. Leaves = entry_hash bytes in seq order. Node = SHA-256(left || right);
odd last node is promoted (not duplicated). Checkpoint payload = JCS of
{tenant_id, seq_from, seq_to, merkle_root, created_at}; signature = Ed25519 over that payload.
Signing key: `MANDATE_SIGNING_KEY` env (PEM). Anchoring for POC = append the signed checkpoint
JSON as a line to a local `anchors.log` file AND print it; treat that file as the out-of-band
record (v1 replaces with WORM storage / TSA).

D6. **Verifier independence:** `packages/verifier` re-implements JCS, hashing, Merkle, and
signature verification with zero imports from other workspace packages. It connects with a
read-only DB role (`mandate_verifier`). Output: human-readable report + exit code 0/1; on
failure it must print the exact seq of the first break.

D7. **Policy evaluation:** first-match-wins over rules in document order, after (a) agent scope
check (tool ∈ allowed_tools else DENY/scope) and (b) before defaults. Agent `max_autonomy` caps
the outcome (ALLOW→ESCALATE if cap is ESCALATE; caps only tighten). No rule matched →
defaults.unknown_tool (DENY in the example policy). The engine must return a rule_trace array of
every rule considered with matched:boolean and a short why string.

D8. **Stateful limits:** two kinds. `count` limit (max N events per window per key) and `sum`
limit (max total of a numeric param per window per key). Key ∈ {agent, principal}. Window is a
fixed sliding window implemented with the `limit_counters` table (window_start bucketing at
1-minute granularity is fine for POC). Counter increments happen in the SAME transaction as the
ledger insert, only for verdicts that consume budget (ALLOW and ESCALATE-then-approved count;
DENY does not).

D9. **Holds:** TTL from the rule (`ttl_minutes`). Expiry → resolved as DENY (fail closed) by a
sweeper that runs every 30s. Self-approval is rejected: the hold stores the initiating principal;
a decision from the same principal is refused and recorded as an event. Approver identity =
mapping from Telegram user id to a `principals` row; unmapped Telegram users cannot decide.

D10. **Idempotency:** `POST /v1/actions/check` requires an `Idempotency-Key` header. Same key +
same tenant within 24h returns the original response; a new ledger entry is NOT written.

D11. **Policy immutability:** policies are rows with (tenant_id, version). Activation writes a
POLICY_ACTIVATED ledger entry containing the SHA-256 of the policy YAML. Never UPDATE a policy
row's document; new version instead.

D12. **Params privacy (POC-simplified):** the full parameters JSON is stored in the ledger entry
payload as-is (encryption is v1); the entry also stores params_hash = SHA-256(JCS(params)). Do
not log params at info level.

D13. **Time and money:** amounts are integer minor units + ISO currency code. The example policy
uses INR paise (₹5,000 = 500000). Timestamps from Postgres now().

D14. **Errors:** DENY is not an HTTP error — it is a 200 with verdict DENY. HTTP errors are
reserved for malformed requests (400), auth failures (401), and server faults (5xx). SDK throws
`PolicyDeniedError` on DENY and `HoldRejectedError`/`HoldExpiredError` on failed escalations.

D15. **Kill switch:** `POST /v1/agents/:id/suspend` sets agents.status='SUSPENDED' and writes an
AGENT_SUSPENDED ledger entry. The gate checks status on every request; suspended → DENY with
reason "agent suspended". Un-suspend is out of POC scope (manual SQL is acceptable).
*Amended by D20.*

---

## Registry milestone (added when the Charter product overview landed)

D16. **The charter is mandatory and the expiry is derived.** An agent cannot exist in the registry
without an `owner_principal` that resolves to a real `principals` row (accountability is a named
human, not a team label), a `department`, and an `expires_at`. `POST /v1/agents` refuses a
registration missing any of them. Stored status is ACTIVE | SUSPENDED | REVOKED; **EXPIRED is
computed from `expires_at` on every read and never stored**, so no sweeper failure can leave a lapsed
charter looking valid. Registration writes an AGENT_REGISTERED entry; the API key is returned exactly
once and only its SHA-256 fingerprint is persisted.

D17. **Authority is a versioned document, and it can only tighten.** Grants are immutable rows
carrying the named grantor, a validity window, an optional budget, `allowed_tools`, `forbidden_ops`,
and `doc_hash` = SHA-256 over JCS of the grant document. A new grant SUPERSEDES the previous version
(never an edit); revocation flips status and stamps the revoking entry; both write ledger entries.
The gate evaluates the grant as an envelope around the policy, and the envelope may only make a
verdict more restrictive — never less. Two consequences chosen deliberately:
  - **Exceeding the grant is DENY, not ESCALATE.** An approver may not hand out authority nobody
    granted them. Escalation thresholds live in policy; boundaries live in the grant.
  - **Budget spend reuses the policy limit machinery** (`limit_counters`, `rule_id =
    authority:<id>`), so it inherits D8 exactly: ALLOW consumes, DENY never consumes, an approved
    ESCALATE consumes at approval time.

D18. **Standing failures short-circuit; envelope failures do not.** No charter, no live grant, an
expired charter, an expired or not-yet-valid grant, or a revoked charter ⇒ DENY with an empty
`rule_trace`: the agent has no standing, so there is nothing to evaluate (same shape as a suspended
agent under D15). A forbidden operation, an ungranted tool, a currency mismatch or a budget breach
⇒ the policy is still evaluated and both views are recorded, because "the policy would have allowed
this and the grant overruled it" is the most valuable line in the evidence.

D19. **Charter is the name on the surface; the protocol constants do not move.** UI, docs, CLI
output and README say Charter. The genesis string stays `MANDATE_GENESIS:<tenant>`, the DB roles stay
`mandate_gate` / `mandate_verifier`, and the workspace scope stays `@mandate/*`. Renaming any of
those would change every `entry_hash` already committed — the chain would have to be abandoned to
win a cosmetic argument. (Note for the record: `usemandate.io` is a listed competitor, which is
exactly why the product-facing name changed and the wire format did not.)

D20. **Reinstatement is an audited action, amending D15.** `POST /v1/agents/:id/reinstate` writes an
AGENT_REINSTATED entry. D15 left un-suspend to manual SQL; a kill switch that can only be released
by hand-editing rows makes the control un-demonstrable and pushes operators toward direct database
access, which is worse than the thing it avoided.

D21. **The gate never dies of a database error.** The `pg` pool has an `error` listener, because an
unhandled idle-client error terminates the process (observed: `docker compose down` under load).
Fail closed means the action does not proceed, not that the enforcement point disappears — a crashed
gate cannot deny anything, cannot answer /healthz 503, and cannot record that it refused.
