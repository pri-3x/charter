import { ulid } from "ulid";
import pg from "pg";
import { loadEnv, canonicalize, sha256Token, genesisPrevHash, jcsHashToken } from "@charter/shared";

/**
 * Bulk-generate a valid synthetic ledger chain for the verifier benchmark (MILESTONES M4:
 * "1M-entry synthetic benchmark < 60s"). Appends N VERDICT entries continuing the current chain,
 * inserted in batches. The chain is REAL (correct prev_hash / entry_hash), so the verifier passes.
 *
 * Usage: npm run gen-synthetic -- 1000000   (default 100000)
 */
loadEnv();

const N = Number(process.argv[2] ?? 100000);
const TENANT = "acme-fintech";
const BATCH = 1000;

function entryHashOf(payload: Record<string, unknown>): string {
  const { entry_hash: _o, ...rest } = payload;
  return sha256Token(canonicalize(rest));
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_SUPERUSER_URL;
  if (!url) throw new Error("POSTGRES_SUPERUSER_URL required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const head = await client.query<{ seq: string | null; entry_hash: string | null }>(
      "SELECT seq, entry_hash FROM ledger_entries WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1",
      [TENANT],
    );
    let seq = head.rows[0]?.seq ? Number(head.rows[0]!.seq) : 0;
    let prevHash = head.rows[0]?.entry_hash ?? genesisPrevHash(TENANT);

    const started = Date.now();
    let done = 0;
    while (done < N) {
      const rows: unknown[][] = [];
      const n = Math.min(BATCH, N - done);
      for (let i = 0; i < n; i++) {
        seq++;
        const entryId = ulid();
        const ts = new Date(started + seq).toISOString();
        const params = { order_id: `O-${seq}`, amount: 10000 + (seq % 90000), currency: "INR" };
        const paramsHash = jcsHashToken(params);
        const payload: Record<string, unknown> = {
          seq,
          entry_id: entryId,
          ts,
          tenant: TENANT,
          kind: "VERDICT",
          agent: { id: "support-agent", key_fingerprint: "sha256:synthetic" },
          principal: `user:bench${seq % 50}@acme.co`,
          action: { tool: "refund", params, params_hash: paramsHash },
          policy: { version: 1, doc_hash: "sha256:synthetic" },
          rule_trace: { scope_ok: true, cap_applied: false, rules: [{ rule_id: "R1-refund-small", matched: true, why: "synthetic" }] },
          verdict: "ALLOW",
          rule_id: "R1-refund-small",
          prev_hash: prevHash,
        };
        const entryHash = entryHashOf(payload);
        payload.entry_hash = entryHash;
        prevHash = entryHash;
        rows.push([TENANT, seq, entryId, "VERDICT", JSON.stringify(payload), paramsHash, payload.prev_hash, entryHash, ts]);
      }
      // multi-row insert
      const values: string[] = [];
      const flat: unknown[] = [];
      rows.forEach((r, idx) => {
        const b = idx * 9;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::timestamptz)`);
        flat.push(...r);
      });
      await client.query(
        `INSERT INTO ledger_entries (tenant_id, seq, entry_id, kind, payload, params_hash, prev_hash, entry_hash, ts) VALUES ${values.join(",")}`,
        flat,
      );
      done += n;
      if (done % 50000 === 0) console.log(`  inserted ${done}/${N} …`);
    }
    // keep ledger_seq consistent so the gate can continue the chain afterwards
    await client.query("UPDATE ledger_seq SET last_seq=$1 WHERE tenant_id=$2", [seq, TENANT]);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`generated ${N} synthetic entries (now up to seq ${seq}) in ${secs}s`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
