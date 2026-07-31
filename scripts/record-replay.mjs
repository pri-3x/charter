/**
 * Capture a real run of the gate into `packages/console/public/replay.json`.
 *
 * Why this exists: the landing page's decision flow is real — every row is an HTTP call to a live
 * gate. Hosted as a static page there is no gate behind it, and the honest fallback ("static copy")
 * left a 500px empty frame that reads as a crash rather than as an absence.
 *
 * So instead of inventing rows, this records genuine ones. It drives the exact same seven cases the
 * page drives, against a running gate, and writes down what actually came back — verdict, rule id,
 * ledger entry id, latency — plus the real chain and checkpoint the ASCII panels draw from. The
 * hosted page replays that and says so, in the header and on a badge. A recording of a real run is
 * not a mock-up, but it is only honest if it is labelled, so the page never claims to be live.
 *
 * Run against a seeded local gate:  node scripts/record-replay.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const BASE = process.env.CHARTER_BASE_URL ?? "http://127.0.0.1:8090";
const TENANT = "acme-fintech";

// Exactly the cases landing.html cycles through, in the same order.
const CASES = [
  { txt: "Refund a customer", tool: "refund", rupees: 200 },
  { txt: "Email the customer", tool: "send_email", rupees: 0 },
  { txt: "Refund a customer", tool: "refund", rupees: 80000 },
  { txt: "Refund a customer", tool: "refund", rupees: 450 },
  { txt: "Pay out to a bank", tool: "initiate_payout", rupees: 500 },
  { txt: "Look up an order", tool: "lookup_order", rupees: 0 },
  { txt: "Delete a record", tool: "delete_record", rupees: 0 },
];

function paramsFor(c) {
  const params = { currency: "INR" };
  if (c.rupees > 0) params.amount = c.rupees * 100;
  if (c.tool === "lookup_order") params.order_id = "ORD-4471";
  if (c.tool === "send_email") params.to = "customer@example.com";
  if (c.tool === "delete_record") {
    params.record_id = "CUST-1";
    params.record_type = "customer";
  }
  return params;
}

async function main() {
  const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
  if (!health.ok) throw new Error("gate is not healthy");

  const creds = await fetch(`${BASE}/v1/dev/credentials`).then((r) => r.json());
  const agentId = creds.agents["refunds-agent"] ? "refunds-agent" : Object.keys(creds.agents)[0];
  const agentKey = creds.agents[agentId];
  const admin = creds.admin_key;

  console.log(`[record] gate ${BASE} · rules v${health.active_policy_version} · agent ${agentId}`);

  const rows = [];
  for (const c of CASES) {
    const started = Date.now();
    const res = await fetch(`${BASE}/v1/actions/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentKey}`,
        "Idempotency-Key": `replay-${started}-${Math.random().toString(36).slice(2, 8)}`,
      },
      body: JSON.stringify({
        tool: c.tool,
        params: paramsFor(c),
        principal: "user:visitor@example.com",
        context: { reasoning: "Recorded for the Charter landing page." },
      }),
    });
    if (!res.ok) throw new Error(`${c.tool} -> HTTP ${res.status}`);
    const body = await res.json();
    rows.push({
      txt: c.txt,
      tool: c.tool,
      rupees: c.rupees,
      verdict: body.verdict,
      rule_id: body.rule_id ?? null,
      reason: body.reason ?? null,
      entry_id: body.entry_id ?? null,
      latency_ms: Date.now() - started,
    });
    console.log(`  ${c.tool.padEnd(16)} ${String(body.verdict).padEnd(9)} ${body.rule_id ?? ""}`);
  }

  const auth = { Authorization: `Bearer ${admin}` };
  const [ledger, cps] = await Promise.all([
    fetch(`${BASE}/v1/ledger?tenant=${TENANT}&limit=400`, { headers: auth }).then((r) => r.json()),
    fetch(`${BASE}/v1/ledger/checkpoints?tenant=${TENANT}`, { headers: auth }).then((r) => r.json()),
  ]);

  const counts = { ALLOW: 0, DENY: 0, ESCALATE: 0 };
  for (const e of ledger.entries ?? []) if (e.verdict && counts[e.verdict] !== undefined) counts[e.verdict]++;

  // Only what the panels actually read, so the fixture stays small: entry hashes for the chain, and
  // the newest checkpoint for the Merkle tree and the seal.
  const chain = (ledger.entries ?? []).map((e) => ({ entry_hash: e.entry_hash }));
  const checkpoints = (cps.checkpoints ?? []).map((c) => ({
    seq_from: String(c.seq_from),
    seq_to: String(c.seq_to),
    merkle_root: c.merkle_root,
    signature: c.signature,
  }));

  const out = {
    recorded_at: new Date().toISOString(),
    gate: { policy_version: health.active_policy_version, tenant: TENANT },
    rows,
    counts,
    entry_count: (ledger.entries ?? []).length,
    chain,
    checkpoints,
    note:
      "A recording of a real run against a live Charter gate. Replayed on the hosted page because a " +
      "static site has no gate behind it. Nothing here is synthesised — run Charter locally to decide live.",
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const dest = join(resolve(here, ".."), "packages", "console", "public", "replay.json");
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `[record] wrote ${dest}\n         ${rows.length} verdicts · ${out.entry_count} entries · ${checkpoints.length} checkpoints`,
  );
}

main().catch((err) => {
  console.error(`[record] failed: ${err.message}`);
  process.exit(1);
});
