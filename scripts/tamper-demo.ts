import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { loadEnv, canonicalize, sha256Token, jcsHashToken } from "@charter/shared";
import { makePool, appendEntry, loadSigner, createPendingCheckpoint } from "@charter/gate";
import { verify } from "@charter/verifier";

/**
 * Scripted tamper demo (MILESTONES M4 task 4). Run after `npm run db:reset && npm run keygen`.
 * Adds a few entries, seals a checkpoint, then shows:
 *   T1 — a naïve payload edit → verifier FAILs with entry_hash mismatch at the exact seq.
 *   T3/T4 — a sophisticated rewrite that re-chains the tail so every hash links → still caught,
 *           because the signed Merkle checkpoint's root no longer matches.
 * Each tamper is restored afterward, ending with a clean OK.
 */
loadEnv();

const TENANT = "acme-fintech";
const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m" };
const line = (s = "") => console.log(s);
const hdr = (s: string) => line(`\n${C.bold}${C.cyan}${s}${C.reset}`);

function entryHashOf(payload: Record<string, unknown>): string {
  const { entry_hash: _o, ...rest } = payload;
  return sha256Token(canonicalize(rest));
}

interface VerifyReport {
  ok: boolean;
  entriesChecked: number;
  checkpointsChecked: number;
  failure?: { kind: string; seq?: number; checkpointId?: string; detail: string };
}

async function runVerifier(): Promise<VerifyReport> {
  const pubPath = process.env.CHARTER_SIGNING_PUB_PATH ?? "./keys/signing.pub.pem";
  const publicKeyPem = existsSync(pubPath) ? readFileSync(pubPath, "utf8") : undefined;
  const anchorsPath = process.env.ANCHORS_LOG_PATH ?? "./anchors.log";
  const anchors = existsSync(anchorsPath)
    ? readFileSync(anchorsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : undefined;
  const report = await verify({
    connectionString: process.env.VERIFIER_DATABASE_URL ?? process.env.POSTGRES_SUPERUSER_URL!,
    tenant: TENANT,
    ...(publicKeyPem ? { publicKeyPem } : {}),
    ...(anchors ? { anchors } : {}),
  });
  line(`  ${C.dim}entries ${report.entriesChecked} · checkpoints ${report.checkpointsChecked}${C.reset}`);
  if (report.ok) line(`  ${C.green}✔ verifier: OK — ledger intact${C.reset}`);
  else line(`  ${C.red}✘ verifier: FAIL [${report.failure!.kind}] ${report.failure!.seq !== undefined ? "@ seq " + report.failure!.seq : "@ checkpoint " + report.failure!.checkpointId}${C.reset}\n    ${C.dim}${report.failure!.detail}${C.reset}`);
  return report as VerifyReport;
}

/**
 * A tamper demo has one failure mode worse than a broken tamper: a tamper that quietly does nothing
 * while the verifier says "intact", which reads as "tampering is undetectable". So every step states
 * what it expects and the script exits non-zero if reality disagrees.
 */
const failures: string[] = [];

function expectDetected(step: string, report: VerifyReport, kinds: string[]): void {
  if (report.ok) {
    failures.push(`${step}: the verifier reported OK — the tamper did not apply, so nothing was proven`);
    line(`  ${C.red}✘ EXPECTED A DETECTION HERE — see the summary below${C.reset}`);
    return;
  }
  const kind = report.failure!.kind;
  if (!kinds.includes(kind)) {
    failures.push(`${step}: detected as '${kind}', expected one of ${kinds.join(" / ")}`);
    line(`  ${C.yellow}⚠ detected, but as '${kind}' rather than ${kinds.join(" / ")}${C.reset}`);
  }
}

function expectClean(step: string, report: VerifyReport): void {
  if (!report.ok) {
    failures.push(`${step}: expected a clean ledger, got ${report.failure!.kind}`);
  }
}

async function main(): Promise<void> {
  const su = new pg.Client({ connectionString: process.env.POSTGRES_SUPERUSER_URL });
  await su.connect();
  const gatePool = makePool(process.env.DATABASE_URL!);
  const signer = loadSigner(process.env.CHARTER_SIGNING_KEY_PATH ?? "./keys/signing.pem");

  try {
    hdr("① Building a small ledger and sealing a signed checkpoint");
    const writtenSeqs: number[] = [];
    const client = await gatePool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < 6; i++) {
        const params = { order_id: `O-${100 + i}`, amount: 20000 + i * 1000, currency: "INR" };
        const appended = await appendEntry(client, {
          tenant: TENANT,
          kind: "VERDICT",
          entryId: `demo-${Date.now()}-${i}`.replace(/[^a-zA-Z0-9-]/g, ""),
          paramsHash: jcsHashToken(params),
          body: {
            agent: { id: "support-agent", key_fingerprint: "sha256:demo" },
            principal: "user:rahul@acme.co",
            action: { tool: "refund", params, params_hash: jcsHashToken(params) },
            policy: { version: 1, doc_hash: "sha256:demo" },
            rule_trace: { scope_ok: true, cap_applied: false, rules: [] },
            verdict: "ALLOW",
            rule_id: "R1-refund-small",
          },
        });
        writtenSeqs.push(appended.seq);
      }
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const cp = await createPendingCheckpoint(gatePool, signer, TENANT);
    line(`  sealed checkpoint over seq ${cp!.seq_from}–${cp!.seq_to}  merkle_root ${cp!.merkle_root.slice(0, 16)}…`);
    expectClean("① baseline", await runVerifier());

    /*
     * The victim must be an entry this script wrote, not an offset from the checkpoint's start. The
     * seal covers every un-checkpointed entry, which on a fresh chain includes the seed's own
     * POLICY_ACTIVATED / AGENT_REGISTERED / AUTHORITY_GRANTED records — and those carry no
     * action.params.amount, so an offset-picked victim made the payload edit a silent no-op and the
     * demo then reported a clean ledger after "tampering".
     */
    const victimSeq = writtenSeqs[2]!;
    const victimPayload = (
      await su.query<{ payload: { action?: { params?: { amount?: number } } } }>(
        "SELECT payload FROM ledger_entries WHERE tenant_id=$1 AND seq=$2",
        [TENANT, victimSeq],
      )
    ).rows[0]!.payload;
    if (victimPayload.action?.params?.amount === undefined) {
      throw new Error(
        `seq ${victimSeq} has no action.params.amount to forge — refusing to run a tamper that would change nothing`,
      );
    }

    // ---------------- T1 ----------------
    hdr(`② T1 — naïve tamper: edit the amount on seq ${victimSeq} (no re-hash)`);
    const snap = (await su.query("SELECT payload, prev_hash, entry_hash FROM ledger_entries WHERE tenant_id=$1 AND seq=$2", [TENANT, victimSeq])).rows[0];
    await su.query("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update");
    const edited = await su.query(
      "UPDATE ledger_entries SET payload = jsonb_set(payload, '{action,params,amount}', '9999999') WHERE tenant_id=$1 AND seq=$2 AND payload#>>'{action,params,amount}' IS NOT NULL",
      [TENANT, victimSeq],
    );
    await su.query("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update");
    if (edited.rowCount !== 1) {
      throw new Error(`the T1 edit matched ${edited.rowCount} rows — nothing was tampered with`);
    }
    line(`  ${C.yellow}payload amount rewritten to 9,999,999 with the DISABLE TRIGGER trick${C.reset}`);
    expectDetected("② T1", await runVerifier(), ["entry_hash_mismatch"]);
    // restore
    await su.query("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update");
    await su.query("UPDATE ledger_entries SET payload=$1 WHERE tenant_id=$2 AND seq=$3", [snap.payload, TENANT, victimSeq]);
    await su.query("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update");
    line(`  ${C.dim}(restored)${C.reset}`);

    // ---------------- T3/T4 ----------------
    hdr(`③ T3/T4 — sophisticated tamper: rewrite seq ${victimSeq} AND re-chain the tail`);
    const tail = (await su.query("SELECT seq, payload, prev_hash, entry_hash FROM ledger_entries WHERE tenant_id=$1 AND seq>=$2 ORDER BY seq ASC", [TENANT, victimSeq])).rows;
    // Deep-clone: we mutate tail[i].payload below, which would otherwise alias these snapshots.
    const originals = tail.map((r) => ({ seq: Number(r.seq), payload: JSON.parse(JSON.stringify(r.payload)), prev_hash: r.prev_hash, entry_hash: r.entry_hash }));
    await su.query("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update");
    let running = tail[0].prev_hash as string; // predecessor stays valid
    for (let i = 0; i < tail.length; i++) {
      const p = tail[i].payload as Record<string, unknown>;
      if (i === 0) {
        // Guarded: the victim was checked above, but the tail is read fresh, so never assume shape.
        const action = p.action as { params?: Record<string, unknown> } | undefined;
        if (!action?.params) throw new Error(`seq ${tail[i].seq} has no action.params to forge`);
        action.params.amount = 9999999; // the forgery
      }
      p.prev_hash = running;
      const eh = entryHashOf(p);
      p.entry_hash = eh;
      running = eh;
      await su.query("UPDATE ledger_entries SET payload=$1, prev_hash=$2, entry_hash=$3 WHERE tenant_id=$4 AND seq=$5", [JSON.stringify(p), p.prev_hash, eh, TENANT, Number(tail[i].seq)]);
    }
    await su.query("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update");
    line(`  ${C.yellow}rewrote seq ${victimSeq} and re-hashed every entry after it — the chain links perfectly now${C.reset}`);
    line(`  ${C.dim}entry-level checks will PASS; only the signed checkpoint can catch this${C.reset}`);
    expectDetected("③ T3/T4", await runVerifier(), [
      "checkpoint_root_mismatch",
      "checkpoint_signature_invalid",
    ]);
    // restore
    await su.query("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update");
    for (const o of originals) {
      await su.query("UPDATE ledger_entries SET payload=$1, prev_hash=$2, entry_hash=$3 WHERE tenant_id=$4 AND seq=$5", [o.payload, o.prev_hash, o.entry_hash, TENANT, o.seq]);
    }
    await su.query("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update");
    line(`  ${C.dim}(restored)${C.reset}`);

    hdr("④ Clean again");
    expectClean("④ restored", await runVerifier());
    line("");

    if (failures.length > 0) {
      line(`${C.red}${C.bold}tamper demo FAILED its own expectations:${C.reset}`);
      for (const f of failures) line(`  ${C.red}✘ ${f}${C.reset}`);
      line("");
      process.exitCode = 1;
    } else {
      line(`${C.green}every tamper was detected, and the restored ledger verifies clean.${C.reset}\n`);
    }
  } finally {
    await su.end();
    await gatePool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
