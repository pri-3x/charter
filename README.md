# Charter — POC

**Accountability infrastructure for AI workers.** Every agent chartered, every action countersigned,
every record provable.

Companies are hiring AI "employees" that refund money, send mail and update records — with none of
the accountability machinery every human employee has. Charter is five modules on one spine:

| Module | What it is |
|---|---|
| **Registry** | Every agent chartered: named human owner, department, approver chain, mandatory expiry. Registration is a ledger event; a lapsed charter is denied everything. |
| **Authority** | A versioned grant document — named grantor, validity window, daily budget, allowed tools, forbidden operations. The gate enforces it, and it can only ever tighten a verdict. |
| **Gate** | Deterministic authorization before execution: grant envelope → scope → ordered rules → velocity limits → autonomy caps. ALLOW / DENY / ESCALATE, single-digit milliseconds. Fail closed everywhere. |
| **Approvals** | An escalation freezes the action and sends a context packet to a human. Timeouts deny. Self-approval is refused. |
| **Evidence** | Per-tenant hash chain, signed Merkle checkpoints, an independent verifier that shares zero code with the writer, and a regulator-mapped attestation pack. |

> **Naming:** the product is Charter. The wire format is not renamed — the genesis string
> (`MANDATE_GENESIS:<tenant>`), the DB roles and the `@mandate/*` package scope keep their original
> spelling, because changing them would invalidate every hash already committed (DECISIONS D19).

Read in this order: `CLAUDE.md` → `docs/DECISIONS.md` → `docs/SPEC.md` → `docs/API.md` →
`docs/TEST_PLAN.md` → `PROGRESS.md`.

## Quickstart

```bash
cp env.example .env
npm i
npm run keygen                 # Ed25519 checkpoint signing key (writes ./keys)
npm run db:reset               # Postgres 16 in docker (host :5433), migrate, seed the registry
npm run dev:gate               # gate on :8080  (npm run dev also starts the Telegram bot)
```

Then, in another shell:

```bash
npm run demo -- --fresh        # the whole story in seven acts, unattended, no API keys needed
npm test                       # 99 unit tests
npm run test:integration       # 48 scenarios against real Postgres
npm run verify                 # independent verifier over the whole chain
```

Everything runs with **no Anthropic key and no Telegram token**: the demo agent's model is a
deterministic fixture, and countersignatures go through the same decision endpoint the Telegram bot
uses. Set `ANTHROPIC_API_KEY` and add `--live` to `npm run demo:agent` for a real tool-use loop; set
`TELEGRAM_BOT_TOKEN` and run `npm run dev:approvals` for real one-tap approvals on a phone.

## The console

With the gate running:

- **http://localhost:8080/** — the landing page
- **http://localhost:8080/console/** — the operator console

Paste the admin key and the agent keys from `.seed/agent-key.json` into **Settings** (nothing leaves
your browser). Then:

- **Registry** — charter cards: owner, department, expiry, grant, budget gauge, allowed vs forbidden
  operations. Charter a new agent, issue or revoke a grant, pull the kill switch, reinstate.
- **Gate** — a live ledger tail (SSE) plus one-click actions that exercise every verdict: ₹200 refund
  (allowed), ₹80,000 injected attack (frozen), a payout the policy allows but the grant forbids
  (denied), a delete (denied), a refund past the daily budget (denied).
- **Approvals** — the countersignature docket: the action, the agent's own stated reasoning, the
  matched rule, the grant it was measured against, and Approve / Reject. Self-approval is refused.
- **Policies** — the rulebook as a document: edit the active YAML, **Validate as draft** (a draft
  changes nothing), then **Activate** (new version, POLICY_ACTIVATED entry, doc hash). The panel lists
  which agents are in scope and flags any that are chartered but absent from the policy — such an
  agent is denied `defaults.unknown_agent` regardless of its grant, so **an agent needs both a grant
  and a policy version that names it**. The Registry detail panel links straight here with the agent's
  block pre-inserted.
- **Evidence** — recomputes every entry hash and the Merkle roots **in your browser** (a third
  implementation, independent of both the gate and the CLI verifier) and names the exact sequence
  number if anything was altered.
- **Attestation** — the pack a compliance officer hands an auditor, mapped to RBI maker-checker,
  EU AI Act Art. 12/14 and SOC 2 CC7/CC8, printable, with its own reproducible hash.

## Commands

| Command | What it does |
|---|---|
| `npm run db:reset` | Fresh Postgres + migrations + seeded registry (3 chartered agents, one deliberately expired) |
| `npm run dev` / `dev:gate` / `dev:approvals` | Gate (+ Telegram bot) with watch |
| `npm test` / `test:integration` | Unit tests / scenario suite against real Postgres |
| `npm run demo -- --fresh` | Seven-act end-to-end demo, unattended |
| `npm run demo:agent -- --scenario S1,S3,A1` | Drive individual scenarios through the guarded agent |
| `npm run adversarial` | A1 injection · A2 structuring · A3 soft delete · A4 documented bypass |
| `npm run soak` | S20: 1,000 checks at 50/sec with latency budgets + chain check |
| `npm run tamper-demo` | Edits a committed record and shows the verifier catching it |
| `npm run verify` | The independent verifier (own JCS, hashing, Merkle, Ed25519) |

## Honest limits of this build

- **Enforcement is integration-shaped.** An agent that never calls the gate is not governed by it —
  scenario **A4** demonstrates the bypass on purpose and shows that it leaves no trace in the ledger.
  The credential-custody proxy that makes bypass structurally impossible is the next thing to build,
  not a nice-to-have (DECISIONS D1).
- Anchoring is a local append-only file, not WORM storage or a timestamping authority (D5).
- Action parameters are stored in the clear; encryption is post-POC (D12).
- Policy rules match on tool and parameter values, not semantics: `update_record status=deleted` is
  allowed and merely *evidenced* (**A3**), which is documented rather than papered over.
- Charter evidences controls. It does not certify compliance — an assessor does that.
