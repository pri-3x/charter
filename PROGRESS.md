# PROGRESS.md

## Hosted gate — public demo endpoints, serverless entrypoint  ✅ (2026-09-10)

**Built.** The landing page was hosted with nothing behind it: `/v1/*` 404'd, so every live surface
fell back to `replay.json` and honestly labelled itself "recorded". This makes the hosted page
genuinely live without ever putting a credential in a browser.

- `packages/gate/src/demo.ts` — three public endpoints, documented in `docs/API.md`.
  `POST /v1/demo/decide` takes only a case index into a fixed seven-action list and re-enters the
  real `/v1/actions/check` via `app.inject()` with the agent key held server-side.
  `GET /v1/demo/artefacts` returns entry hashes, checkpoints and verdict counts — exactly the fields
  the ASCII panels sample, nothing more. `GET /v1/demo/attestation` wraps `/v1/attestation` with the
  tenant and window pinned, HTML only. One per-IP token bucket across all three (20 burst, 0.5/s).
- `packages/console/public/landing.html` — the live path no longer touches `/v1/dev/credentials`.
  `loadCreds()` is gone, replaced by `probeGate()`, which asks `/healthz` and then the demo endpoint
  (health alone is not enough: the demo endpoints answer 503 without their key). `decide()` POSTs a
  case index; `render()` reads `/v1/demo/artefacts`; the "Open a real report" button opens
  `/v1/demo/attestation` synchronously off the click, since awaiting first and then calling `open()`
  is what popup blockers exist to stop. The `creds` variable became `liveGate` — it is a boolean flag
  now, and the old name claimed something untrue about the page.
- `packages/gate/src/serverless.ts` + `api/{index,cron/holds,cron/checkpoint}.ts` — a cached app over
  a module-level pool, plus `sweepHolds()` / `sealCheckpoint()` for Vercel cron. `signerFromPem()`
  added to `checkpoint.ts` so the signing key can arrive as an env string instead of a file path.
- `scripts/build-api.mjs` — esbuild bundle to `dist-api/gate.mjs` (~2.3 MB). Needs a `createRequire`
  banner: Fastify and avvio are CJS and die on "Dynamic require of node:events is not supported".
- `vercel.json` — build runs both bundlers, `/healthz` and `/v1/:path*` rewrite to the function,
  crons at 5 and 15 minutes, `no-store` on everything under `/v1/`.

**Verified.** Live path against a real gate on :8090 — header resolves to "Live", nine rows of real
verdicts including an ESCALATE that resolved through the Telegram hold ("finance-lead approved"),
tally 7/2/2, all four panels drawn from live hashes with a real Merkle root and Ed25519 prefix, and
the report button serving a 27 KB pack with no credential anywhere in it. No-gate path against
`dist-web` on a plain static server — amber dot, "Real verdicts · recorded Jul 31, 2026", captions
carrying "· from a real run". `npm test` 99/99, `tsc -b` clean.

**Deviations.** Two degradations are inherent to serverless and are named in comments where they
apply, not papered over: the anchors log does not exist on a read-only filesystem, and hold TTL is
enforced to cron granularity (5 min) rather than continuously. The rate limiter is per-instance, so
the nominal rate is a floor, not a ceiling — recorded in `demo.ts` along with why the structural
containment (fixed case list, small agent budget) is what actually holds.

**Left.** Provision managed Postgres and set `DATABASE_URL`, `CHARTER_ADMIN_KEY`, `CRON_SECRET`,
`CHARTER_SIGNING_KEY_PEM`, `CHARTER_DEMO_AGENT_KEY` in Vercel. `checkPolicy` still accepts a policy
with an uncovered amount band (found by writing one: tightening a ceiling to `lte: 400000` left
400001–500000 matched by no rule, and requests fell through to the velocity rule) — it should reject
coverage gaps at activation.

## Public site — domain, mark, waitlist  ✅ (2026-08-03)

Front-end and deployment only. No gate, SDK, policy or schema code touched.

### What landed

- **`usecharter.xyz`** attached (GoDaddy DNS → Vercel). The canonical origin is now a constant in
  `scripts/build-static.mjs` rather than derived from `VERCEL_PROJECT_PRODUCTION_URL`, which would
  have pointed canonical, `og:url` and the sitemap at the `.vercel.app` copy and told crawlers *that*
  was the original.
- **The keyhole mark**, adopted as a counterform — see the note below on why the shape had to invert.
- **The waitlist works.** Formspree, with a `_gotcha` honeypot and a `_subject` so notifications are
  scannable. The confirmation state is wired to a 2xx and nothing else; a failed POST or an
  unconfigured endpoint never shows it.
- Nav centred with the status chip pinned, a scroll-spy that boxes the section under a reading line at
  38% viewport height, and the compliance section now naming SOC 2 / EU AI Act / RBI control
  references lifted verbatim from `controls.ts`.

### Two findings worth keeping

**The keyhole only works as a void.** Drawn as the positive shape it was sketched as, at 300px on the
social card the identical geometry reads unmistakably as a chess pawn wearing a belt. It is legible
only as an aperture, so the tile is the surface and the keyhole is the hole through it. Every 16px
preview hid this — it appeared only at poster size, which inverts the usual "test it small" advice.

**Formspree needs a form-encoded body, not JSON.** Verified against the live endpoint:

| body | status | content-type | `Access-Control-Allow-Origin` |
|---|---|---|---|
| JSON | 202 | `text/html` | **absent** |
| form-encoded | 200 | `application/json` | present |

With JSON the browser rejects the response even though Formspree accepted the submission, so the
visitor is told it failed while their address quietly arrives. Invisible to any stubbed test. It also
turns out `Accept: application/json` *is* honoured on the error path — an empty submission returns a
proper 400 JSON body — so only the success path falls back to the HTML flow.

### Deployment note (a self-inflicted one)

Four commits (`b9adcd8`…`e8cbc87`) never reached production. Vercel refuses to deploy a commit whose
author email it cannot map to a GitHub account, and every one of those commits was authored
`priyanshu@totofinance.co` — not because git was misconfigured (the global config was correct all
along) but because the commits were made with an explicit `-c user.email=` override. The fix is to
stop overriding it. Worth knowing that Vercel fails this closed and silently: the pushes succeeded,
the site simply stopped updating, and the only visible symptom was a stale `age` header.

## Landing page — density pass + two new sections  ✅ (2026-07-30)

Front-end only. No gate, SDK, policy or schema code was touched. Driven by a design reference the
human supplied (contentarchitecture.dev), reproduced in vanilla CSS + canvas 2D — the console still
has no build step and is still served straight out of `packages/console/public`.

### What was built

**1 — Hero density.** The paper column bottom-anchored its content (`margin-top: auto` on `.body`),
which left roughly a third of the fold empty above the eyebrow. Changed to `margin: auto 0`, which
centres the block and pushes the status bar to the floor; added the mono qualifier line under the
lede. Measured against the reference: eyebrow now lands at 21% of the fold and the buttons at 74%
(reference: 22% / 68%). Section rhythm tightened from `--s-80`/`--s-48` to `--s-64`/`--s-32`.....

**2 — `§02 The rules` — the character field.** A new full-bleed section whose background is one
sticky viewport-height canvas holding the rulebook set as a monospace character grid (18 clauses,
each row starting at a different offset so it reads as wrapped prose rather than a repeating
texture). The pointer is a lens: within 180px glyphs brighten, and past the halfway point they
scramble to random glyphs at ~14Hz; clicking pushes a ripple of scramble outward. The nine numbered
clauses (`001 / FAIL CLOSED` … `009 / A VERIFIER THAT SHARES NO CODE`) scroll past the fixed field.

Performance shape: the resting field is painted once to an offscreen canvas and blitted each frame;
only cells the lens or a ripple is currently heating get redrawn. That is ~1k cells per frame instead
of the ~12k the grid holds. The rAF loop parks itself when everything has cooled.

**3 — `§05 The artefacts` — ASCII panels from live data.** Four large ASCII-art panels in the
reference's showcase idiom. Each is a diagram drawn to an offscreen canvas and then sampled cell by
cell onto a ten-step density ramp — there are no image files. The diagrams are driven by real data
read from `/v1/ledger` and `/v1/ledger/checkpoints`:

| Panel | Source | What sets the shape |
|---|---|---|
| The chain | ledger entries | one block per verdict; block height and internal density from its own `entry_hash` bytes |
| A checkpoint | latest checkpoint | binary tree over `seq_from…seq_to`; node brightness from `merkle_root` bytes |
| Every verdict | verdict counts | three full-width bands, height = the true ALLOW/ESCALATE/DENY proportion |
| The signature | checkpoint signature | concentric rings, thickness from the Ed25519 signature bytes |

Downstream sections were renumbered (03 the decision, 04 for engineers, 06 compliance, 07 where it
stands) and the pill nav gained `The rules` and `Artefacts`.

### Verified

- `tsc -b --noEmit` → 0 errors. `npm test` → 9 files / 99 tests pass.
- `npm run test:integration` → 5 files / **48 tests pass** (S-series, T1–T6, A1–A4) against a freshly
  reset Postgres.
- `npm run demo -- --fresh` → all seven acts pass end to end: ALLOW in 29ms, the injected
  ₹80,000 refund frozen and countersigned, `authority.forbidden_operation` beating the permissive
  policy rule, the attestation pack written, T1 caught as `entry_hash_mismatch` @ seq 98, T3/T4
  caught as `checkpoint_root_mismatch`, and the restored ledger verifying clean.
- Inline script: `node --check` clean, and the top-level global-shadowing scan (the `const top`
  class of bug) still reports none.
- Both new sections confirmed on screen at 1440px, plus numeric checks: field canvas paints
  (max alpha 35 at rest, 255 inside the lens, 7410 lit subpixels), all four ASCII panels render
  64 rows of live data with correct captions (`234 entries`, `seq 223–234 · root 1e27367b04bd…`,
  `120 allowed · 32 to a person · 38 blocked`).

### Fixes made along the way

1. **Every `.sec.wrap` section had lost its side gutters.** `.sec { padding: var(--s-80) 0 }` in the
   page's inline `<style>` ties with `.wrap { padding: 0 var(--s-24) }` on specificity and wins on
   order, so the shorthand zeroed the horizontal padding — §01, §04 and §07 were rendering flush to
   the viewport with text clipping on the right. Now `padding-block`.
2. **Compliance grid footers floated.** `.evid > div` given `grid-template-rows: auto auto 1fr auto`
   so the "proved by" rules align across a row (verified pairwise-identical offsets).
3. **`.mono` was uppercasing identifiers** (`PolicyDeniedError` → `POLICYDENIEDERROR`). Split into a
   font-only `.mono` and the label classes that do the casing.
4. **The code sample lost its line breaks** — a `div` collapses whitespace; it is now a `pre`.
5. **The seal read as a solid disc.** 14 rings at that radius overlapped; reduced to 9 with the
   stroke capped at 0.55× the ring spacing, and added a hashed background field of the signature
   bytes so the panel is not a small circle in an empty box.
6. **The seal's background field showed a diagonal lattice** because a linear index (`y*31 + x*7`)
   walks the byte array at a fixed stride. Hash the coordinate first.
7. **ASCII column count was a hardcoded advance guess.** Now measured from the panel's own computed
   font, and a 4s backstop renders the panels if IntersectionObserver never fires (a backgrounded
   tab delivers no intersection callbacks, which left them on "reading the ledger…" indefinitely).

### Hero copy pass (same day, after review)

The headline made the reader pause: "whether it **may**" is grammatically right but not instantly
obvious, and it left "what does *may* refer to — block, approve, or audit?" open. The lede was one
paragraph carrying four ideas (policy engine, approval workflow, immutable log, trust).

- Headline → **"Your AI can spend money. Charter decides when it can."** with the accent on *when*,
  which is the word doing the work. Two lines, one sentence each.
- Lede split into three single-line facts — the check, the three outcomes, the record — so it scans
  instead of reads. `.lede`'s 60ch cap had to be overridden on the stack; it wrapped every line.
- "including by us" → **"Not even Charter can edit it."** The original read as defensive hedging.
- "Every action an agent takes is checked…" → "Every action is checked…".
- Console `index.html` h1 and the page `<meta name="description">` updated to match.

**The headline size now tracks the column, not the viewport.** Each line is its own `overflow: hidden`
row for the entrance animation, so a wrapped line breaks the animation as well as the reading. The
longest line measures 12.05× its font size; the column is `0.54vw - 48` until it caps at 760px, which
makes the exactly-fitting size range 4.08vw–4.17vw across 980–1440px. The previous `4.6vw / 62px`
wrapped at every width, and `4.1vw / 58px` sat inside the range with no headroom (fine at 1280, wrapped
at 1024). Now `clamp(26px, 3.9vw, 56px)`, verified to fit with 4–6% slack at 1920/1600/1440/1280/1152/
1024/980/900/768/540/414/375; only a 320px viewport wraps, and it wraps rather than clipping.
Re-measure the 12.05 ratio if the headline text or column width changes.

### Environment note (not a spec change)

- `.env` `PORT` moved 8080 → **8090**. Another service on this machine holds 8080, and the demo and
  SDK both default to `PORT`, so `npm run demo` needed a `CHARTER_BASE_URL` override on every run.
  `env.example` still documents 8080.

### Worth knowing (no code change made)

- `PolicyStore` caches the active policy per tenant in-process and invalidates only on activation —
  which is exactly what SPEC step 3 specifies. The consequence in the dev loop is that
  `npm run test:integration` (and any bare `db:reset`) wipes the database underneath a *running*
  gate, and the gate then keeps serving the pre-reset version: `/healthz` reported
  `active_policy_version: 3` while the `policies` table held only version 1. Restarting the gate
  after a reset clears it. Flagged rather than changed, since the cache is spec'd behaviour and
  cross-process invalidation is explicitly out of scope for the POC.

## M5 + Registry/Authority + Charter front end  ✅ (2026-07-26)

Driven by the *Charter — Product Overview* doc, which added two modules the original pack did not
have (Registry §5.1, Authority §5.2) and set the public-demo bar. Built in five phases; every phase
verified by running it, not by reading it.

### What was built

**P1 — Registry + Authority (the modules that were missing)**
- Migration `0002_registry_authority.sql`: charter fields on `agents` (`owner_principal` FK to
  `principals`, `department`, `purpose`, `approver_chain`, **mandatory `expires_at`**, `registered_at`),
  status widened to ACTIVE|SUSPENDED|REVOKED, plus a new immutable `authorities` table (ref, version,
  grantor, validity window, budget, allowed_tools, forbidden_ops, doc + doc_hash, one ACTIVE grant per
  agent via a partial unique index). Four new ledger kinds: AGENT_REGISTERED, AGENT_REINSTATED,
  AUTHORITY_GRANTED, AUTHORITY_REVOKED.
- `gate/src/registry/store.ts` — register / grant / revoke / reinstate, each in ONE transaction with
  its ledger entry; `loadCharter` resolves every time comparison in Postgres (never the app clock).
- `gate/src/registry/authority.ts` — the pure envelope evaluator (12 unit tests). Checks in order:
  charter revoked → charter expired → grant present → grant window → forbidden_ops → allowed_tools →
  currency → budget. Every check, passed or failed, lands in `authority.checks[]` in the VERDICT
  payload, so evidence shows which grant a verdict was measured against.
- Endpoints: `GET/POST /v1/agents`, `GET /v1/agents/:id`, `POST /v1/agents/:id/authorities`,
  `POST /v1/authorities/:id/revoke`, `POST /v1/agents/:id/reinstate`.
- Seed now charters three agents: `support-agent` (test workhorse, high grant ceiling),
  `refunds-agent` (the demo star — Sarah's agent, the §5.2 card verbatim: ₹1,00,000/day, payouts
  forbidden), and `collections-agent` (**charter deliberately lapsed**, so the registry shows a real
  EXPIRED card and S21 has a subject).

**P2 — M5 demo agent, adversarial suite, soak** (`packages/demo-agent`, 17 source files)
- Guarded tool loop over the real SDK; **two modes**: a deterministic fixture model (default, needs no
  API key — what the public demo and CI use) and `--live` for a real Anthropic tool-use loop.
- Scenario driver (`--scenario S1,S3,S9,S22,A1..A4`, `--all`, `--interactive`, `--approve/--reject`),
  run-scoped fixture principals so the 24h velocity limit cannot leak between runs.
- `npm run soak` (S20) and `npm run adversarial`.

**P3 — Evidence surface** (`packages/gate/src/attestation/`, `stream.ts`)
- `GET /v1/attestation` — the pack a compliance officer hands an auditor: registry + grants in force,
  enforcement counts by verdict/tool/rule, money allowed vs denied, maker-checker rows with decision
  latency and a per-row self-approval assertion, chain + checkpoint coverage, control mapping to RBI
  maker-checker / EU AI Act Art. 12+14 / SOC 2 CC7+CC8, and a limitations section that names D1.
  `format=html` renders a self-contained printable report. `pack_hash` deliberately excludes
  `header.generated_at`, so regenerating the same period reproduces the hash.
- `GET /v1/stream` — SSE tail of new ledger entries (heartbeats, capped batches, cleanup on disconnect).

**P4 — the Charter front end** (`packages/console/public/`, no build step)
- A vintage certificate/ledger design system (`charter.css`): laid cream paper, engraved display
  serif, typewriter figures, rubber-stamp verdicts in oxblood and banknote green, gold guilloche
  engraving generated in JS rather than shipped as images, and a **walnut** dark stock the Evidence
  room switches to automatically. Fonts are system faces with web-safe fallbacks — no webfont, no
  network, renders identically offline.
- Six routed pages: Registry (charter cards with budget gauge and allowed/forbidden ink lists),
  Gate (SSE live tail + one-click actions for every verdict shape), Approvals (countersignature
  dockets), Evidence, Attestation, Settings.
- **The Evidence page recomputes the chain in the browser** — its own RFC 8785 canonicalizer +
  `crypto.subtle` SHA-256, walking prev_hash link by link from genesis, plus Merkle root
  reconstruction per checkpoint. A third implementation, independent of both the gate and the CLI
  verifier. Measured: 199 entries verified in 72ms; a checkpoint root reproduced from 74 leaves.
- The old M1–M4 console is preserved at `packages/console/legacy/`.

**P5 — `npm run demo`** — seven acts, unattended: the register → ₹200 allowed → the ₹80,000 injected
attack frozen and countersigned → a payout the policy allows but the grant forbids, denied → the
attestation pack written to disk → an insider edit caught by the verifier at the exact seq → the
restored ledger verifying clean. `--fresh` rebuilds the chain first (see the budget note below).

### Results — clean run (`npm run db:reset && npm test && npm run test:integration && npm run verify`)

| Suite | Result |
|---|---|
| Unit | **99 passed** (JCS 13 · policy evaluator 11 · authority envelope 12 · attestation coverage 10 · demo-agent 53) |
| Integration | **48 passed** — M2 14 · M3 5 · M4 7 · M5 registry 12 · M5 evidence 10 |
| `tsc --noEmit` | 0 errors |
| Verifier | OK — ledger intact |
| S20 soak | **PASS** · 1,000 checks at 50.0/sec · 0 errors · gate eval+commit p50 **6.3ms** p95 12.1ms p99 **29.9ms** · round trip p50 10.4ms p99 44.2ms · 1,001 entries link cleanly |
| A1–A4 | all PASS (see notes) |
| Demo | seven acts end to end, exit 0 |

New scenarios: **S21** expired charter → DENY `charter.expired` with no rules evaluated · **S22**
policy-allowed / grant-forbidden payout → DENY `authority.forbidden_operation` with both facts in the
entry · **S23** revoke → `authority.missing`, 409 on double revoke, re-grant restores · **S24** past
the daily budget → DENY `authority.budget_exceeded` consuming nothing.

### Bugs found and fixed while verifying (all found by running, not reading)

1. **The gate crashed when Postgres went away.** The `pg` pool had no `error` listener, so an error on
   an *idle* client (a restart, a failover, `docker compose down`) raised an unhandled `'error'` event
   and killed the process. Fail closed must mean "the action does not proceed", not "the enforcement
   point disappears" — a dead gate cannot deny, cannot serve /healthz 503, and cannot record a
   refusal. Fixed in `db.ts` (D21) and verified: DB killed → 503 and the process stays up → DB back →
   healthy again, no restart.
2. **The tamper demo reported a clean ledger after "tampering".** It picked its victim as
   `checkpoint.seq_from + 2`; once the seed wrote registry entries, that offset landed on an
   AGENT_REGISTERED row with no `action.params.amount`, so the `jsonb_set` edit matched nothing and the
   verifier — correctly — said OK. A tamper demo that cannot tell "detected" from "nothing happened" is
   worse than none, so it now targets an entry it wrote itself, asserts the edit changed exactly one
   row, and **asserts the expected detection kind at every step**, exiting non-zero otherwise.
   Now: T1 → `entry_hash_mismatch @ seq 16`; T3/T4 → `checkpoint_root_mismatch`; restored → clean.
3. **A contradictory seeded grant** listed `initiate_payout` in both `allowed_tools` and
   `forbidden_ops`; the API's own validation (correctly) refuses that combination, so a re-grant
   through the API 400'd. Caught by the S23 test. The grant fixture was fixed, not the validation.
4. **S20 measured the wrong thing** — client round trip rather than the gate's eval+commit that the
   TEST_PLAN budgets. At 50 concurrent, round-trip p99 was 254ms and the run "failed"; the gate's own
   p99 was 29.9ms. It now asserts on `Server-Timing` and reports round trip alongside, and refuses to
   fall back to round-trip data silently.
5. TypeScript: `observed` was narrowed to `never` because it is assigned from inside a guard callback
   the compiler cannot follow — read through a method now, with the reason written down.

### Deviations from DECISIONS.md (each recorded as a new decision)

- **D16–D18** register the new semantics: mandatory owner+expiry with EXPIRED *derived* rather than
  stored; authority as an immutable versioned document that may only tighten; budget breach as DENY
  rather than ESCALATE (an approver may not grant authority nobody gave them); standing failures
  short-circuit the policy, envelope failures do not.
- **D19** — Charter is the product name; `CHARTER_GENESIS`, the DB roles and `@charter/*` deliberately
  unchanged, because renaming them invalidates every committed hash.
- **D20 amends D15** — reinstatement is an audited endpoint. A kill switch releasable only by hand-
  editing rows is un-demonstrable and pushes operators toward direct DB access.
- **D21** — the pool error listener (bug 1 above).
- `policies/example.acme.yaml` gained `refunds-agent`, `collections-agent`, and rules **R6** (small
  payouts ALLOW — deliberately permissive, so the grant's veto is provable), **R7** (`lookup_order`)
  and **R8** (`update_record`). Without R7/R8 the agent could not even read an order, and A3's
  documented residual risk could not be exercised.

### Notes for the human

- **The demo spends 80% of the demo agent's daily grant**, so a second run on the same chain is
  correctly denied by `authority.budget_exceeded`. `npm run demo -- --fresh` rebuilds the chain first;
  without the flag the preflight explains this rather than failing three acts later.
- `db:reset` now also clears `anchors.log` (`scripts/reset-anchors.mjs`): anchors from a destroyed
  chain reference sequence numbers that no longer exist, which the verifier correctly reads as
  truncation — a false alarm on an otherwise clean demo.
- **A3 residual risk** (unchanged, now demonstrated): `update_record status=deleted` is ALLOWed
  because rules match tools and values, not semantics. The ledger captures the exact params and their
  hash, so it is provable after the fact. The mitigation is policy authoring, not engine work:
  `when: { tool: update_record, params.value: { in: [deleted, purged] } } → DENY`.
- **A4 bypass, measured:** the raw tool call succeeded and **wrote nothing to the ledger** — the
  bypass is invisible to the audit trail, which is the sharper version of D1's warning and the
  strongest argument for the credential-custody proxy tier.
- Two things remain manual and are the only untested paths: a real Telegram round-trip (needs a bot
  token) and `--live` against the Anthropic API (needs a key). `ANTHROPIC_MODEL` defaults to
  `claude-sonnet-4-6` per CLAUDE.md; if that id is rejected, set `ANTHROPIC_MODEL=claude-sonnet-5`.

---


## M4 — Merkle checkpoints + independent verifier  ✅ (2026-07-13)

### What was built
- **Merkle module** (`gate/src/merkle.ts`, D5): root + inclusion-proof path over raw 32-byte entry-hash
  leaves; parent = SHA-256(left‖right); odd trailing node **promoted** (not duplicated); root as hex.
- **Checkpoint worker** (`gate/src/checkpoint.ts`, SPEC 4.3): seals all un-checkpointed entries
  (crash-safe — starts just after the last `seq_to`) into a signed checkpoint. Payload =
  JCS of `{tenant_id, seq_from, seq_to, merkle_root, created_at}`; **Ed25519** signature (base64).
  Runs on a 5-min `setInterval` in the gate and appends each signed checkpoint as a JSON line to
  `anchors.log` (out-of-band record). Disabled with a warning if no signing key is present.
- **Keygen** (`scripts/keygen.ts`): Ed25519 PEM pair (`CHARTER_SIGNING_KEY_PATH` private /
  `CHARTER_SIGNING_PUB_PATH` public — the latter is all the verifier needs).
- **Endpoints**: `GET /v1/ledger/checkpoints` and `GET /v1/ledger/proof/:entry_id` (Merkle path +
  root + signature — a third-party inclusion proof; 404 if not yet checkpointed).
- **Independent verifier** (`packages/verifier`, D6): its **own** JCS, hashing, Merkle, and Ed25519
  verification — **zero imports from any workspace package** (verified). Connects with the read-only
  `charter_verifier` role. Streams entries in seq batches; recomputes each entry_hash, checks chain
  continuity + column↔payload consistency, rebuilds + signature-checks every checkpoint, and detects
  truncation against `anchors.log`. Prints a report with the exact first-break seq/checkpoint; exit 0/1.
- **`npm run tamper-demo`**: scripted narrative — seal a checkpoint, then (T1) a naïve payload edit
  caught at the exact seq, and (T3/T4) a sophisticated rewrite that re-chains the tail so every hash
  links yet is still caught by the signed checkpoint. Restores and ends clean.
- Operator console gained a **Checkpoints** page (list + fetch inclusion proof).

### Results
- **T1–T6 all detected with correct localization** (`tests/integration/m4.tamper.test.ts`, 7 tests):
  T1 entry_hash_mismatch @ seq · T2 seq_gap @ successor · T3/T4 checkpoint_root_mismatch (entry-level
  checks pass, checkpoint catches it) · T5 checkpoint_signature_invalid · T6 truncation vs anchors.
- **1M-entry benchmark: verifier ran over 1,000,001 entries + a signed checkpoint in ≈11s** (target
  <60s). Generation via `npm run gen-synthetic -- 1000000` (~44s); checkpoint seal ≈2.3s.
- The clean-ledger verify doubles as a **cross-check that the gate's and verifier's independent JCS
  implementations agree** over the entire real M1–M3 chain.
- Full suite: 24 unit + 26 integration (M2 14 · M3 5 · M4 7) pass; `tsc --noEmit` → 0 errors.
  Inclusion proof independently reconstructed the 1M checkpoint root (20-step path).

### Notes
- **Canonical Merkle byte convention** (documented in `merkle.ts`, mirrored in the verifier): leaves
  are the hex-decoded 32 bytes of `entry_hash`; `merkle_root` serialized as lowercase hex. The gate
  and verifier re-implement this identically-but-independently (D6).
- Verifier checks **signature before root** so localizations match the scenarios: T5 (root column
  altered, signature over the old root) surfaces as `checkpoint_signature_invalid`; T3/T4 (entries
  rewritten, checkpoint row untouched) surface as `checkpoint_root_mismatch`.
- Signing key config uses the **path** form from `env.example` (`CHARTER_SIGNING_KEY_PATH`) rather
  than an inline-PEM `MANDATE_SIGNING_KEY` env var (D5 mentioned the latter); the keygen script writes
  the PEM files. Functionally equivalent; noted for fidelity.

---

## M3 — Approvals + kill switch + SDK  ✅ (2026-07-13)

### What was built
- **Hold read + decision** — `GET /v1/holds/:id` (agent-of-tenant or admin) and
  `POST /v1/holds/:id/decision` (admin / approvals service). Decision logic in `holds-resolve.ts`:
  404 unknown, 409 already-resolved, **403 self-approval** (initiating principal, written nowhere
  on the chain — S8), 403 non-approver; on success writes an **APPROVAL** ledger entry and resolves
  the hold, all in one transaction. An APPROVED escalation applies the **deferred limit consumption**
  it recorded at verdict time (D8 "ESCALATE-then-approved counts") — carried in the VERDICT payload's
  `deferred_consume` and replayed here.
- **Expiry sweeper** (`expireHolds`, D9) — resolves every PENDING hold past its TTL as **EXPIRED**
  (APPROVAL entry, decided_by null), fail closed. Runs on a 30s `setInterval` in the gate process
  (it needs ledger-write access) and is also callable directly (tests invoke it).
- **Kill switch** (`suspend.ts`, D15) — `POST /v1/agents/:id/suspend` sets status SUSPENDED + writes
  an **AGENT_SUSPENDED** entry; the check handler denies a suspended agent (`agent_suspended`) before
  the policy is consulted.
- **SDK** (`packages/sdk`) — `CharterClient` (`check`, `reportResult`, `getHold`) and `guard()`:
  ALLOW → run fn + report OUTCOME; DENY → `PolicyDeniedError`; ESCALATE → poll the hold until
  APPROVED (run fn) / REJECTED (`HoldRejectedError`) / EXPIRED (`HoldExpiredError`). Poll interval
  configurable; fail-closed on 5xx (fn never runs).
- **Approvals bot** (`packages/approvals`) — grammy long-polling bot: polls the DB for new PENDING
  holds, sends a context packet (tool, ₹amount, agent, principal, matched rule + reason, reasoning,
  velocity readout) with inline Approve/Reject buttons, maps the Telegram user → principal, relays to
  the decision endpoint (honoring the 403 self-approval), and edits the message with the outcome.
  Idles cleanly without `TELEGRAM_BOT_TOKEN`. **Manual check only** (needs a real bot + chat) — not in
  the automated suite.
- Operator console upgraded: hold **Approve/Reject** controls in the ledger detail pane (verified in a
  real browser: escalation → APPROVED by monty → APPROVAL entry appears) and an **agent suspend**
  action. Checkpoints remain disabled pending M4.

### Scenario results (`npm run db:reset && npm test && npm run test:integration`)

| Scenario | Asserts | Result |
|---|---|---|
| S5  | escalation APPROVED by monty → APPROVAL entry (decided_by); SDK guard() runs fn; OUTCOME written | ✅ |
| S6  | escalation REJECTED → SDK throws HoldRejectedError; fn never runs; no OUTCOME | ✅ |
| S7  | TTL elapsed → sweeper writes EXPIRED (decided_by null); SDK throws HoldExpiredError; fn never runs | ✅ |
| S8  | self-approval (initiator) → 403, hold stays PENDING; a different approver then resolves it | ✅ |
| S15 | suspend → AGENT_SUSPENDED entry; subsequent checks DENY "agent suspended" | ✅ |
| S1–S4 | re-run under M3 code — still green | ✅ |

24 unit tests + 19 integration scenarios (M2 14 + M3 5) pass; `tsc --noEmit` → 0 errors.
Integration files run **serially** (`fileParallelism: false`) since S15 suspends the shared agent;
the M3 file restores it to ACTIVE in `afterAll` (un-suspend is manual SQL per D15).

### Deviations & notes (flagged)
1. **Expiry sweeper runs in the gate process, not the approvals service** (MILESTONES M3 put it in
   approvals). It writes ledger entries, so it belongs with the chain-writing code and the gate DB
   role; placing it there also makes it deterministically testable. The approvals bot focuses on
   notify + relay-decision. No DECISION is affected (D9 doesn't fix the process).
2. **SDK `guard()` awaits the OUTCOME report** (catching/swallowing errors) rather than strict
   fire-and-forget (SPEC §7), so the audit OUTCOME is durably recorded before the call returns and
   tests are deterministic. A failed report never masks the action result.
3. **ESCALATE-then-approved consumption** (D8) is implemented via `deferred_consume` in the VERDICT
   payload, applied in the approval transaction. No scenario asserts it, but it honors D8 without a
   schema change.

### Open question for the human
- The Telegram round-trip is the one manual acceptance step: set `TELEGRAM_BOT_TOKEN` and the tenant's
  `approver_chat` (env `TELEGRAM_APPROVER_CHAT` at seed, or update the tenants row), run
  `npm run dev:approvals`, and approve a live escalation. Want me to walk through wiring a bot token?

---

## Frontend — landing page + operator console (extra — outside core POC scope)  ✅ (2026-07-13)

Requested explicitly by the user; SPEC §10 lists a web dashboard as out of POC scope, so this is an
add-on, not a milestone deliverable. Static, no build step, served by the gate via `@fastify/static`
(same-origin → no CORS, no extra process). Static serving is guarded by `existsSync`, so tests are
unaffected.

- **Landing page** — `packages/console/public/landing.html`, served at `/`: hero, the core-invariant
  callout, the agent → SDK guard() → gate → ledger commit → verdict flow, feature cards, a live
  health + active-policy readout (fetches `/healthz`), and build-status pills.
- **Operator console SPA** — `packages/console/public/index.html`, served at `/console/`, split into
  **routed pages** via hash routes with a shared nav bar and shared connection state:
  - **Ledger** (`#ledger`) — filterable ledger table + detail pane: per-entry **rule_trace**,
    **hash chain** (prev/entry), full payload, and for ESCALATE entries the **hold controls**
    (Approve/Reject with an approver selector → `POST /v1/holds/:id/decision`).
  - **Checks** (`#checks`) — submit `POST /v1/actions/check`; verdict badge + rule_id/reason/hold.
  - **Policies** (`#policies`) — active version readout; create draft → activate.
  - **Agents** (`#agents`) — suspend agent (kill switch); note pointing hold decisions to the Ledger.
  - **Settings** (`#settings`) — connection (base URL, admin key, agent key, tenant), health check.
- Verified end-to-end in a real browser across milestones: ALLOW check → entry + cross-cutting
  rule_trace (R1 verdict + R5 limit both matched); ESCALATE → **Approve** in the ledger detail →
  hold APPROVED + APPROVAL entry appears; landing page live health; routed nav switching.
- Checkpoints remain disabled pending **M4**.

---

## M2 — Real policy engine  ✅ (2026-07-13)

### What was built
- **Policy schema + parser** (`policy/schema.ts`): zod validation of the YAML policy doc (defaults,
  per-agent `allowed_tools`/`max_autonomy`, rules with `when` matchers, verdict/limit rules). Strict
  objects; a limit rule must be count XOR sum and must carry `verdict_on_breach`.
- **Lifecycle** (`policy/activate.ts` + `policy/store.ts`): `POST /v1/policies` stores an immutable
  draft (negative provisional version), `POST /v1/policies/:draft_id/activate` assigns
  version=max+1, retires the prior active, writes a **POLICY_ACTIVATED** ledger entry with the doc
  SHA-256 (D11), and invalidates the in-process active-policy cache — all in one transaction.
  `example.acme.yaml` is seeded active as version 1 via this same path.
- **Evaluator** (`policy/evaluate.ts`, SPEC 3.3 / D7): scope check, `when` matchers
  `eq/gt/gte/lt/lte/in` with missing-param ⇒ no-match, first-match-wins verdict rule, cross-cutting
  limit rules, autonomy cap, `defaults.unknown_tool`. Emits a full `rule_trace`
  (`scope_ok`, `cap_applied`, per-rule `{matched, why}`).
- **Stateful limits** (`policy/limits.ts`, D8): count + sum over `limit_counters` in 1-minute
  buckets; window usage summed via SQL; increments applied **in the verdict transaction**, only when
  the final verdict is ALLOW (DENY never consumes; ESCALATE consumption is deferred to approval in
  M3).
- **Holds on ESCALATE** (`policy/holds.ts`): a PENDING hold row is written in the verdict
  transaction with `ttl_at = now()+ttl_minutes` and an approver snapshot (role → principal ids).
  Response carries `hold_id` + `ttl_minutes`. (GET/decision/bot/sweeper land in M3.)
- Interim M1 policy removed; the real evaluator is wired into `POST /v1/actions/check`.

### Scenario results (clean DB: `npm run db:reset && npm test && npm run test:integration`)

| Scenario | Asserts | Result |
|---|---|---|
| S1  | refund 20,000 → ALLOW R1; payload reconstructs (policy v1); OUTCOME; dup 409 | ✅ |
| S2  | 499,900 and exactly 500,000 → ALLOW R1 (lte inclusive) | ✅ |
| S3  | 500,100 → ESCALATE R2; hold PENDING, ttl_at ≈ now+240m, approvers resolved to monty+steven | ✅ |
| S4  | 5,000,000 → ESCALATE R2 | ✅ |
| S9  | delete_record → DENY R3, exact reason | ✅ |
| S10 | wire_transfer (out of scope) → DENY, scope_ok=false, no rules evaluated | ✅ |
| S11 | totally_unknown → DENY via defaults.unknown_tool | ✅ |
| S12 | 20 emails ALLOW, 21st DENY R4; counter=20 (DENY didn't consume) | ✅ |
| S13 | 11×490,000: 1–10 ALLOW, 11th ESCALATE R5; sum stays 4,900,000 (breach didn't consume) | ✅ |
| S14 | activate policy w/ max_autonomy ESCALATE → small refund ESCALATEs, cap_applied | ✅ |
| S16 | idempotency: identical body, replay header, one entry | ✅ |
| S17 | activate v2 → before ref v1, after ref v2, POLICY_ACTIVATED w/ doc_hash between | ✅ |
| S18 | DB down → healthz 503, check 5xx (fail closed) | ✅ |
| S19 | malformed body → 400 zod details, no entry | ✅ |

24 unit tests (JCS + evaluator) pass; 14 integration scenarios pass; `tsc --noEmit` → 0 errors.

### Deviations & reconciliations (flagged per the working agreement)
These resolve **internal inconsistencies** where the SPEC 3.3 pseudocode / example policy could not
satisfy the authoritative TEST_PLAN. All are the fail-closed reading and none re-open a DECISION.

1. **Cross-cutting limit rules + most-restrictive combine.** SPEC 3.3's pseudocode is strict
   first-match-wins with a `break`, but under `example.acme.yaml` a small refund matches R1 (ALLOW)
   and would `break` before reaching R5 (velocity sum) — making **S13 impossible**. Resolution: the
   first matching *verdict* rule sets the base verdict (first-match-wins among verdict rules), and
   every matching *limit* rule is also evaluated; the final verdict is the **most restrictive** of
   all contributions (DENY > ESCALATE > ALLOW). This can only *tighten* the base verdict, so it is
   the fail-closed reading. `rule_id` reported is the rule that set the winning verdict.
2. **`delete_record` added to `allowed_tools`** in `example.acme.yaml`. S9 requires R3 to fire, but
   R3 is only reached if the tool is in scope. SPEC §8 explicitly calls delete_record a tool the
   agent *can request* but policy denies — so it belongs in scope, denied by R3 (not a scope block).
3. **Out-of-scope tool ⇒ DENY via `defaults.unknown_tool`** with `scope_ok=false` and no rules
   evaluated. This unifies S10 (wire_transfer: "scope block, no rules") and S11 (totally_unknown:
   "via defaults.unknown_tool"), which are otherwise the same case (tool ∉ allowed_tools).
4. **Cap-induced / ESCALATE verdicts do not consume limit budget at verdict time** (D8:
   "ALLOW and ESCALATE-then-approved count"). Consumption for approved escalations is deferred to the
   approval transaction in M3.

### Open questions for the human
- Confirm the cross-cutting-limits reconciliation (#1) matches intent, or whether R5 was meant to be
  ordered before R1 in the example policy (which would make pure first-match-wins work but change
  which rule_id small refunds report).
- Confirm adding delete_record to allowed_tools (#2) is acceptable vs. treating it as a scope block.

---

## M1 — Skeleton gate + chained ledger  ✅ (2026-07-13)

### What was built

**Monorepo scaffold**
- npm workspaces (`packages/{shared,gate,sdk,approvals,verifier,demo-agent}`); `sdk`/`approvals`/
  `verifier`/`demo-agent` are placeholder manifests (built in later milestones).
- TypeScript strict via a single `tsconfig.json` with path aliases (`@charter/shared`, `@charter/gate`)
  — everything runs on `tsx`/`vitest`, no build step. `npx tsc --noEmit` → **0 errors**.
- `docker-compose.yml` → Postgres 16; `db/init/00_roles.sql` creates the `charter_gate` (app) and
  `charter_verifier` (read-only) roles at container init.
- Migration runner `scripts/migrate.ts` (tracks applied files in `_migrations`); `0001_init.sql` is a
  verbatim copy of `db/schema.sql`.
- Seed `scripts/seed.ts`: tenant `acme-fintech`, agent `support-agent` (API key printed once + written
  to gitignored `.seed/agent-key.json` for tests), principals `user:monty@acme.co` /
  `user:steven@acme.co` (role `finance-lead`), `ledger_seq` row.
- Root scripts: `db:up`, `db:migrate`, `db:reset`, `seed`, `test`, `test:integration`, `dev`.

**`packages/shared`** — RFC 8785 JCS (`jcs.ts`) + hashing (`hashing.ts`) + domain types (`types.ts`).
- JCS delegates number/string serialization to the platform (which RFC 8785 defines to be identical to
  ECMAScript `ToString`/JSON string production) and implements the two things JCS actually adds:
  deterministic UTF-16 key ordering and rejection of non-finite numbers.
- `computeEntryHash` (D3: SHA-256 over JCS with `entry_hash` absent), `genesisPrevHash`
  (D4: `CHARTER_GENESIS:<tenant>`), `jcsHashToken` (params_hash, D12).
- **Property tests** (`jcs.test.ts`, 2500 random values): idempotence, key-order independence,
  round-trip; plus RFC 8785 number/string known vectors and unicode.

**`packages/gate`** — Fastify service.
- Bearer auth: agent key → SHA-256 fingerprint lookup; admin key from env (`auth.ts`).
- `POST /v1/actions/check` with the **hard-coded interim policy** (`interim-policy.ts`:
  refund ≤ 500000 → ALLOW `R1-refund-small`; `delete_record` → DENY `R3-no-deletes`; else DENY
  `defaults.unknown_tool`). Rule ids match the real policy so these tests survive into M2.
- Transactional seq + chain + insert (`ledger.ts`): `SELECT ... FOR UPDATE` on `ledger_seq` (D4),
  `prev_hash` = genesis or previous `entry_hash`, `ts` from Postgres `now()`, `entry_hash` over JCS,
  INSERT. **Verdict is returned only after COMMIT** (core invariant).
- Idempotency (D10): `Idempotency-Key` required; replay returns the stored body + `Idempotency-Replayed`
  header and writes no new entry; lost-race unique violation resolves to a replay.
- `POST /v1/actions/:entry_id/result` → OUTCOME entry (404 unknown / 409 duplicate).
- `GET /v1/ledger` (admin, filters + `next_from_seq` pagination), `GET /healthz` (503 when DB down).
- Latency: eval+commit ms logged per request and exposed via a `Server-Timing` header.
- Logs never carry raw params (verified): `params_hash` logged instead; pino redaction as backstop.

### Verified invariants (beyond the scenarios)
- Chain linkage `prev_hash[n] == entry_hash[n-1]` holds across all seeded entries.
- Append-only: `charter_gate` is **grant-denied** UPDATE/DELETE on `ledger_entries`; the trigger blocks
  even the superuser; `charter_verifier` is grant-denied INSERT (read-only).
- Live server smoke test (ALLOW / DENY / replay header / 401 / admin ledger) all correct.

### Scenario results

| Scenario | What it asserts | Result |
|---|---|---|
| S1  | refund 20,000 → ALLOW R1; VERDICT payload reconstructs; OUTCOME after result; dup result → 409 | ✅ PASS |
| S9  | delete_record → DENY R3, exact reason "Agents may never delete records." | ✅ PASS |
| S11 | unknown tool → DENY via `defaults.unknown_tool` | ✅ PASS |
| S16 | same Idempotency-Key → identical body, replay header, exactly ONE ledger entry | ✅ PASS |
| S18 | DB unreachable → `/healthz` 503 and `/check` 5xx (fail closed, no ALLOW); healthy app recovers | ✅ PASS |
| S19 | malformed body (amount string / missing principal) → 400 with zod details; no ledger entry | ✅ PASS |

`npm test` → 13 unit tests pass. `npm run test:integration` → 6 scenarios pass. `tsc --noEmit` → 0 errors.

### Deviations & interim choices (flagged per the working agreement)
None contradict DECISIONS D1–D15. Interim scaffolding choices, all replaced in M2/M3:

1. **Interim policy fail-closed on large refunds.** A refund > 500000 currently returns **DENY** (falls
   through to the default) rather than ESCALATE. Escalation/holds don't exist until M3 and the real
   engine until M2, so the fail-closed reading is used per the working agreement. No M1 scenario covers
   this; M2's real engine makes it ESCALATE (R2).
2. **`policy.version` = `"interim-m1"`** (string) in M1 entries; becomes the real integer version in M2
   (types already allow `number | string`). `policy.doc_hash` is `null` until a policy is activated (M2).
3. **`POST /v1/actions/:entry_id/result` implemented in M1** even though the M1 task list only names
   check/healthz/ledger — S1's acceptance requires an OUTCOME entry, so the result endpoint was needed.
4. **S18 tested via a separate app pointed at an unreachable Postgres**, rather than `docker pause` +
   an SDK spy as the TEST_PLAN wording describes. The SDK doesn't exist until M3 and pausing the shared
   container would flake the rest of the suite; the dedicated dead-pool app proves the same fail-closed
   property (503 healthz, 5xx check, never a 200/ALLOW). The docker-pause + SDK-spy form returns in M3.

### Environment note (not a spec change)
- Docker Postgres is published on host port **5433** (compose + `.env` + `env.example` updated) to avoid
  clashing with a local Homebrew Postgres already bound to `localhost:5432`. Connection strings are
  otherwise as documented. The dev Postgres container is left running; `docker compose down -v` to reset.

### Open questions for the human
- **Interim large-refund verdict:** OK to DENY large refunds during M1 (they ESCALATE from M2)? Flagged
  above as the fail-closed choice.
- **Idempotency-Key required always:** M1 returns 400 if the header is missing on `/check` (per D10). Any
  desire for a grace path? Assumed no (fail closed).

---

## Policy coverage checking (post-M5)

### The defect

SPEC 3.3 gives a matching `limit` rule the verdict `breach ? verdict_on_breach : (rule.verdict ?? ALLOW)`.
Limit rules are cross-cutting guards scoped to a tool, not to a parameter band — `R5-refund-velocity`
matches *every* refund. So tightening `R1-refund-small` from `lte: 500000` to `lte: 400000`, while
`R2-refund-large` still starts at `gt: 500000`, leaves 400001–500000 matched by no verdict rule at all.
The action falls through to R5, does not breach the daily sum, and is **ALLOWED with
`rule_id: R5-refund-velocity`** — a velocity guard silently becomes the thing that authorises the payment.

Reproduced against the real evaluator before any code was written:

```
  amount=400000  verdict=ALLOW    rule=R1-refund-small     matched=[R1-refund-small, R5-refund-velocity]
  amount=450000  verdict=ALLOW    rule=R5-refund-velocity  matched=[R5-refund-velocity]
  amount=500000  verdict=ALLOW    rule=R5-refund-velocity  matched=[R5-refund-velocity]
  amount=500001  verdict=ESCALATE rule=R2-refund-large     matched=[R2-refund-large, R5-refund-velocity]
```

The policy parses, the zod schema is satisfied, and every rule is individually correct. Only the
*union* is wrong, which is why nothing caught it.

### What was built

`packages/gate/src/policy/coverage.ts` — `analyseCoverage(doc)`. Per (agent, tool in `allowed_tools`):

- Rules are split the way `matchRules` splits them: a rule with a `limit` is a **guard** (it can never
  supply the base verdict), anything else is a **verdict rule**.
- **No verdict rule for the tool ⇒ nothing checked.** The tool is governed entirely by guards, which is
  a deliberate uniform choice (`send_email` + `R4-email-rate` in the example policy), not a partition
  with a hole in it. Listed in `skipped` so it is visible rather than silent.
- Otherwise the verdict rules must cover the whole integer range of whichever param they partition on.
  Each uncovered band is reported with the verdict the gate would **actually** return, derived the way
  `resolveVerdict` does: first matching guard's non-breach verdict, else `defaults.unknown_tool`, then
  the agent's autonomy cap.

A gap whose verdict is ALLOW is fail-open and **refuses activation**. A gap landing on DENY or ESCALATE
is reported but does not block — that is the fail-closed direction and is often deliberate (nothing in
the example policy covers payouts above R6's ceiling; DENY is the intended answer).

Checked in `createDraft` *and* `activateDraft`. The second is not redundant: a draft written before this
check existed is still in the table, and activation is the moment the policy starts deciding.

### Soundness

The analyser only reports a gap it can prove. Anything it cannot decide exactly is put in `skipped` with
the reason rather than guessed at — a rule conditioned on more than tool + one numeric param, two verdict
rules partitioning different params, a non-integer or `in`-list bound. Bands are inclusive **integer**
ranges (amounts are minor units), so `lte: 500` and `gt: 500` are recognised as adjacent with no phantom
gap between them. The domain is (-∞, ∞), not [0, ∞): a rule floored with `gte: 0` leaves the negative
side uncovered, and a negative refund is a credit — that is a real finding, and there is a test for it.

### Verification

- `packages/gate/src/policy/coverage.test.ts` — 14 unit tests, including one that cross-checks the
  report against the evaluator itself (the predicted `verdict` and `decided_by` must equal what
  `resolveVerdict` returns for the band), so the report cannot drift from the engine it describes.
- Full unit suite 161 passing; `npm run test:integration` 48 passing from a clean chain, S14/S17
  activation included. The seed activates `example.acme.yaml` through the checked path.
- End-to-end against a live gate: the shipped policy and the S14 capped variant are accepted (with the
  informational payout gap surfaced); the tightened-ceiling policy is refused 400 with 3 gaps, one per
  agent that can call `refund`.

### Deviations

**None from DECISIONS.md, and none from SPEC 3.3.** Evaluation semantics are untouched — a matching
guard still yields `rule.verdict ?? ALLOW`. Changing that would have made `send_email` undecidable in
the example policy, since R4 is the only rule that matches it. The fix is a validation gate in front of
the engine, not a change to the engine.

New API surface (documented in `docs/API.md`): `POST /v1/policies` gains a `coverage` field in its 200
body and a 400 carrying `coverage_gaps`; the activate route returns the same 400.

### Environment note

`CHARTER_DEMO_AGENT_KEY` is now documented in `env.example`. It rotates on every `db:reset`; re-read it
from `.seed/agent-key.json` afterwards or `/v1/demo/*` fails closed with a 502.

---

## M7 — Pattern B: credential custody (the A4 fix)

D1 fixed Pattern A (SDK check) as the POC integration and said the proxy/credential-custody tier is
**v1**, with A4 existing to demonstrate Pattern A's limit — explicitly *not* to be "fixed" in the POC.
This is that v1 tier. Pattern A is untouched and still supported; A4 remains true of it.

### The hole

`guard(tool, fn, opts)` takes the real tool function, and that function holds the API key. The gate is
therefore advisory: an agent that simply calls `fn` directly succeeds, and the ledger never hears
about it. No amount of policy work closes this, because the credential is on the wrong side of the
gate.

### What changed

The secret moves behind the gate. The agent is handed a tool **name**; Charter stores the credential
encrypted, evaluates the action, and makes the outbound call itself. The bypass does not become
logged — it becomes impossible, because the agent has nothing to bypass Charter *with*.

- `db/migrations/0003_credential_custody.sql` — `tool_credentials`, plus `CREDENTIAL_REGISTERED` /
  `CREDENTIAL_REVOKED` entry kinds. `schema.sql` kept in step.
- `credentials/crypto.ts` — AES-256-GCM. **The egress descriptor is bound in as AAD**: `endpoint_url`
  is an ordinary plaintext column, so without this anyone with UPDATE on the row could repoint the
  destination and the gate would attach the production credential to it. With AAD, editing the URL
  destroys the credential instead of redirecting it.
- `credentials/store.ts` — register/rotate/revoke/load. Rotation is an upsert, so there is exactly one
  active credential per tool and "which key signed this?" is never ambiguous.
- `credentials/egress.ts` — the outbound call. Refuses non-https, embedded credentials, loopback,
  RFC1918, CGNAT and link-local (169.254.169.254 is why). `redirect: "manual"` so a 302 cannot carry
  the credential to a new host, and `redact()` scrubs the secret from anything an upstream echoes back.
- `credentials/routes.ts` — admin register/list/revoke, plus `POST /v1/proxy/:tool` and
  `POST /v1/proxy/resume`.
- SDK: `proxy()`, `resume()`, and `custody(tool, opts)` — a drop-in callable, except the tool function
  and its key are no longer passed in at all.

### Two design points worth stating

**The proxy re-enters `/v1/actions/check` in process** rather than reimplementing evaluation. There is
one implementation of authority, policy, limits, holds and the ledger transaction. A proxy verdict is
not a second opinion, it *is* the verdict.

**`resume` takes a hold id and nothing else.** The params are replayed from the immutable verdict
entry, never re-read from the caller — otherwise an agent could get ₹500 approved by a human and then
execute ₹500,000. There is a test for exactly that.

### Bug found by the tests

`writeOutcome` spread the egress detail at the top level of the OUTCOME payload. The upstream's
`status` (an HTTP code) silently overwrote the entry's own `status` (SUCCESS/FAILURE) — same field
name, entirely different meaning, and it would have corrupted every OUTCOME consumer including the
attestation. The upstream reply now lives under `egress`.

### Verification

- 136 unit tests (11 crypto, 12 egress) and 64 integration tests pass, the latter from a clean chain.
- `tests/integration/m6.custody.test.ts` — 16 tests. A stub upstream records every request it
  receives, so "the tool was NOT called" is asserted as a fact rather than an absence of logging:
  DENY calls nothing, ESCALATE calls nothing until approved, a pending hold refuses to resume, an
  approval executes once, revocation bites on the next call, and the plaintext secret appears in no
  response, no admin listing, no ledger entry, and nowhere in the database row.
- `npm run verify` — 106 entries, chain intact with the new kinds present. The verifier shares no code
  with the gate (D6) and types `kind` as an open string, so it needed no change.

### Deviations

None from DECISIONS. D1 is *advanced*, not overturned: it named Pattern B as v1 and this is v1.
A4 still holds for Pattern A, which is unchanged — the new suite adds the Pattern B counterpart
rather than editing A4's expectation.

### Not done

The endpoint host is not resolved before the request, so a hostname resolving to a private address is
not caught, and pinning the resolved address would be needed to close DNS rebinding properly.
Registration is admin-only, so the exposure is a misconfigured admin rather than a hostile caller.
Recorded in `egress.ts` as a named gap rather than papered over.

---

## Hold expiry was only as real as the cron schedule

Found while fixing a Vercel deploy failure, and much more serious than the thing that surfaced it.

`ttl_at` was read in exactly one place: `sweepExpiredHolds`. `decideHold` checked only
`status === 'PENDING'`. So a hold past its TTL stayed **approvable** for as long as the sweeper was
behind — expiry was not a property of the clock, it was a property of whether a background job had
run. A 240-minute hold on a gate whose sweeper was down could be countersigned a day later, and the
approver would see nothing to suggest the window had closed.

`decideHold` now reads `(ttl_at <= now()) AS expired` in the same `FOR UPDATE` select it already
does and refuses with 409. The sweeper still runs; its job is to write the EXPIRED ledger entry
promptly, not to make the expiry real.

Verified the test actually tests it: with the check removed the new case fails, with it restored all
7 in the file pass.

**Why it surfaced now.** Vercel Hobby permits one cron invocation per day, and `vercel.json`
declared `*/5` and `*/15`. Vercel rejects the whole deployment for that, which is why every push
since the file was added silently failed and the site sat on a stale build. The obvious fix — make
the crons daily — would have turned this latent bug into a real one, so the ordering matters: fix
expiry first, then slow the cron down.

`vercel.json` now declares daily jobs (Hobby-compatible) and `.github/workflows/charter-cron.yml`
drives both endpoints every 15 minutes for free, with Vercel's daily runs as a backstop. Actions
cron is best-effort and often late; acceptable because neither job is load-bearing for a verdict.
Needs two repo secrets, `CHARTER_BASE_URL` and `CRON_SECRET`; without them the workflow exits
quietly rather than failing red every quarter hour.

Checkpoint sealing is the part that genuinely wants frequency: a signed checkpoint pins a range of
history to a point in time, so sealing once a day leaves up to 24h un-anchored and weakens the
"when did you know?" property. That is the argument for the Actions job, not the hold sweep.

### Test note

The new cases sit after S15 in `m3.scenarios.test.ts`, which suspends the agent and relies on the
file-level `afterAll` to restore it. Anything appended after S15 therefore runs against a suspended
agent and sees DENY. The block restores the agent in its own `beforeAll`.
