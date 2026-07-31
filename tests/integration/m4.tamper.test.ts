import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { loadEnv, canonicalize, sha256Token, jcsHashToken } from "@charter/shared";
import { makePool, appendEntry, loadSigner, createPendingCheckpoint } from "@charter/gate";
import type { Pool } from "@charter/gate";
import { verify } from "@charter/verifier";
import type { Anchor } from "@charter/verifier";

/**
 * M4 tamper acceptance — T1–T6. The gate seals a signed Merkle checkpoint over the whole chain; the
 * independent verifier (reading via the read-only role) must detect every tamper with correct
 * localization. Each tamper is applied via superuser (disabling the append-only trigger, exactly as
 * the threat model allows) and restored afterward.
 */
loadEnv();

const TENANT = "acme-fintech";
const su = new pg.Client({ connectionString: process.env.POSTGRES_SUPERUSER_URL });
const verifierUrl = process.env.VERIFIER_DATABASE_URL!;
const publicKeyPem = readFileSync(resolve(process.cwd(), process.env.CHARTER_SIGNING_PUB_PATH ?? "./keys/signing.pub.pem"), "utf8");

let gatePool: Pool;
let seqFrom = 0, seqTo = 0, victim = 0;

function entryHashOf(payload: Record<string, unknown>): string {
  const { entry_hash: _o, ...rest } = payload;
  return sha256Token(canonicalize(rest));
}
const run = (extra: Partial<Parameters<typeof verify>[0]> = {}) =>
  verify({ connectionString: verifierUrl, tenant: TENANT, publicKeyPem, ...extra });
const disable = (t: string) => su.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t === "checkpoints" ? "checkpoints_no_update" : "ledger_no_update"}`);
const enable = (t: string) => su.query(`ALTER TABLE ${t} ENABLE TRIGGER ${t === "checkpoints" ? "checkpoints_no_update" : "ledger_no_update"}`);

beforeAll(async () => {
  await su.connect();
  gatePool = makePool(process.env.DATABASE_URL!);
  const signer = loadSigner(resolve(process.cwd(), process.env.CHARTER_SIGNING_KEY_PATH ?? "./keys/signing.pem"));

  // append a handful of entries, then seal every pending entry into one signed checkpoint
  const client = await gatePool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < 8; i++) {
      const params = { order_id: `T-${i}`, amount: 20000 + i, currency: "INR" };
      await appendEntry(client, {
        tenant: TENANT, kind: "VERDICT", entryId: `m4-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        paramsHash: jcsHashToken(params),
        body: { agent: { id: "support-agent", key_fingerprint: "sha256:m4" }, principal: "user:rahul@acme.co", action: { tool: "refund", params, params_hash: jcsHashToken(params) }, policy: { version: 1, doc_hash: "sha256:m4" }, rule_trace: { scope_ok: true, cap_applied: false, rules: [] }, verdict: "ALLOW", rule_id: "R1-refund-small" },
      });
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const cp = await createPendingCheckpoint(gatePool, signer, TENANT);
  seqFrom = cp!.seq_from; seqTo = cp!.seq_to; victim = seqFrom + Math.floor((seqTo - seqFrom) / 2);
});

afterAll(async () => {
  await su.end();
  await gatePool.end();
});

it("clean ledger verifies OK (cross-checks both JCS implementations over the real chain)", async () => {
  const r = await run();
  expect(r.ok).toBe(true);
  expect(r.entriesChecked).toBe(seqTo); // seq 1..seqTo
  expect(r.checkpointsChecked).toBeGreaterThanOrEqual(1);
});

it("T1 — edited payload amount (no re-hash) → entry_hash_mismatch @ seq", async () => {
  const snap = (await su.query("SELECT payload FROM ledger_entries WHERE tenant_id=$1 AND seq=$2", [TENANT, victim])).rows[0];
  await disable("ledger_entries");
  await su.query("UPDATE ledger_entries SET payload=jsonb_set(payload,'{action,params,amount}','9999999') WHERE tenant_id=$1 AND seq=$2", [TENANT, victim]);
  await enable("ledger_entries");
  try {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("entry_hash_mismatch");
    expect(r.failure?.seq).toBe(victim);
  } finally {
    await disable("ledger_entries");
    await su.query("UPDATE ledger_entries SET payload=$1 WHERE tenant_id=$2 AND seq=$3", [snap.payload, TENANT, victim]);
    await enable("ledger_entries");
  }
  expect((await run()).ok).toBe(true);
});

it("T2 — deleted mid-chain entry → seq_gap at the successor", async () => {
  const row = (await su.query(`SELECT entry_id, kind, payload, params_hash, prev_hash, entry_hash, to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts FROM ledger_entries WHERE tenant_id=$1 AND seq=$2`, [TENANT, victim])).rows[0];
  await disable("ledger_entries");
  await su.query("DELETE FROM ledger_entries WHERE tenant_id=$1 AND seq=$2", [TENANT, victim]);
  await enable("ledger_entries");
  try {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("seq_gap");
    expect(r.failure?.seq).toBe(victim);
  } finally {
    await disable("ledger_entries");
    await su.query("INSERT INTO ledger_entries (tenant_id,seq,entry_id,kind,payload,params_hash,prev_hash,entry_hash,ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)", [TENANT, victim, row.entry_id, row.kind, row.payload, row.params_hash, row.prev_hash, row.entry_hash, row.ts]);
    await enable("ledger_entries");
  }
  expect((await run()).ok).toBe(true);
});

async function rewriteAndRechain(fromSeq: number, count: number): Promise<() => Promise<void>> {
  const tail = (await su.query("SELECT seq, payload, prev_hash, entry_hash FROM ledger_entries WHERE tenant_id=$1 AND seq>=$2 ORDER BY seq ASC", [TENANT, fromSeq])).rows;
  // Deep-clone the snapshot: we mutate tail[i].payload below, which would otherwise alias these.
  const originals = tail.map((r) => ({ seq: Number(r.seq), payload: JSON.parse(JSON.stringify(r.payload)), prev_hash: r.prev_hash, entry_hash: r.entry_hash }));
  await disable("ledger_entries");
  let running = tail[0].prev_hash as string;
  for (let i = 0; i < tail.length; i++) {
    const p = tail[i].payload as Record<string, unknown>;
    if (i < count) (p.action as any).params.amount = 8888888 + i;
    p.prev_hash = running;
    const eh = entryHashOf(p);
    p.entry_hash = eh; running = eh;
    await su.query("UPDATE ledger_entries SET payload=$1, prev_hash=$2, entry_hash=$3 WHERE tenant_id=$4 AND seq=$5", [JSON.stringify(p), p.prev_hash, eh, TENANT, Number(tail[i].seq)]);
  }
  await enable("ledger_entries");
  return async () => {
    await disable("ledger_entries");
    for (const o of originals) await su.query("UPDATE ledger_entries SET payload=$1, prev_hash=$2, entry_hash=$3 WHERE tenant_id=$4 AND seq=$5", [o.payload, o.prev_hash, o.entry_hash, TENANT, o.seq]);
    await enable("ledger_entries");
  };
}

it("T3 — forged rewrite of one entry, tail re-chained consistently → checkpoint_root_mismatch", async () => {
  const restore = await rewriteAndRechain(victim, 1);
  try {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("checkpoint_root_mismatch"); // entry-level checks pass; checkpoint catches it
  } finally { await restore(); }
  expect((await run()).ok).toBe(true);
});

it("T4 — rewrite a batch, re-chained consistently → checkpoint_root_mismatch", async () => {
  const restore = await rewriteAndRechain(victim, 2);
  try {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("checkpoint_root_mismatch");
    expect(r.failure?.checkpointId).toBeTruthy();
  } finally { await restore(); }
  expect((await run()).ok).toBe(true);
});

it("T5 — altered checkpoint merkle_root → checkpoint_signature_invalid", async () => {
  const before = (await su.query("SELECT id, merkle_root FROM checkpoints WHERE tenant_id=$1 ORDER BY seq_from ASC LIMIT 1", [TENANT])).rows[0];
  await disable("checkpoints");
  await su.query("UPDATE checkpoints SET merkle_root=$1 WHERE id=$2", ["deadbeef".repeat(8), before.id]);
  await enable("checkpoints");
  try {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe("checkpoint_signature_invalid");
    expect(r.failure?.checkpointId).toBe(before.id);
  } finally {
    await disable("checkpoints");
    await su.query("UPDATE checkpoints SET merkle_root=$1 WHERE id=$2", [before.merkle_root, before.id]);
    await enable("checkpoints");
  }
  expect((await run()).ok).toBe(true);
});

it("T6 — anchors reference entries beyond the ledger's max seq → truncation", async () => {
  const anchor: Anchor = { id: "anchor-future", tenant_id: TENANT, seq_from: seqTo + 1, seq_to: seqTo + 5, merkle_root: "00", created_at: "2026-01-01T00:00:00.000Z", signature: "x" };
  const r = await run({ anchors: [anchor] });
  expect(r.ok).toBe(false);
  expect(r.failure?.kind).toBe("truncation");
});
