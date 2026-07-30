import pg from "pg";
import { canonicalize } from "./jcs.js";
import {
  sha256Hex,
  genesisPrevHash,
  computeEntryHash,
  leafFromEntryHash,
  merkleRootHex,
  verifyEd25519,
} from "./crypto.js";

const { Client } = pg;
const BATCH = 5000;

export interface Anchor {
  id: string;
  tenant_id: string;
  seq_from: number;
  seq_to: number;
  merkle_root: string;
  created_at: string;
  signature: string;
}

export interface VerifyOptions {
  connectionString: string;
  tenant: string;
  fromSeq?: number;
  publicKeyPem?: string;
  anchors?: Anchor[];
}

export interface Failure {
  kind: string;
  detail: string;
  seq?: number;
  checkpointId?: string;
}

export interface VerifyReport {
  ok: boolean;
  tenant: string;
  entriesChecked: number;
  checkpointsChecked: number;
  failure?: Failure;
  warnings: string[];
}

interface EntryRow {
  seq: string;
  entry_id: string;
  kind: string;
  payload: Record<string, unknown>;
  params_hash: string | null;
  prev_hash: string;
  entry_hash: string;
}

/**
 * Independently verify a tenant's ledger (SPEC §5). Streams entries in seq order, recomputing each
 * entry_hash from its payload, checking chain continuity + column↔payload consistency, then rebuilds
 * and signature-checks every Merkle checkpoint, and (with anchors) detects truncation. Returns the
 * first break with its exact seq / checkpoint id.
 */
export async function verify(opts: VerifyOptions): Promise<VerifyReport> {
  const client = new Client({ connectionString: opts.connectionString });
  await client.connect();
  const warnings: string[] = [];
  const fromSeq = opts.fromSeq ?? 1;
  let entriesChecked = 0;
  let checkpointsChecked = 0;

  try {
    // --- boundary prev_hash ---
    let prevHash: string;
    if (fromSeq <= 1) {
      prevHash = genesisPrevHash(opts.tenant);
    } else {
      const b = await client.query<{ entry_hash: string }>(
        "SELECT entry_hash FROM ledger_entries WHERE tenant_id = $1 AND seq = $2",
        [opts.tenant, fromSeq - 1],
      );
      if (b.rowCount === 0) {
        return fail(opts, entriesChecked, checkpointsChecked, warnings, {
          kind: "seq_gap",
          detail: `--from-seq ${fromSeq} but predecessor seq ${fromSeq - 1} is missing`,
          seq: fromSeq - 1,
        });
      }
      prevHash = b.rows[0]!.entry_hash;
    }

    // --- Steps 1 & 2: entry hash recompute + chain + column/payload consistency ---
    let expectedSeq = fromSeq;
    let cursor = fromSeq;
    for (;;) {
      const res = await client.query<EntryRow>(
        `SELECT seq, entry_id, kind, payload, params_hash, prev_hash, entry_hash
           FROM ledger_entries WHERE tenant_id = $1 AND seq >= $2 ORDER BY seq ASC LIMIT $3`,
        [opts.tenant, cursor, BATCH],
      );
      if (res.rowCount === 0) break;

      for (const row of res.rows) {
        const seq = Number(row.seq);
        if (seq !== expectedSeq) {
          return fail(opts, entriesChecked, checkpointsChecked, warnings, {
            kind: "seq_gap",
            detail: `expected seq ${expectedSeq} but found ${seq} (entry ${row.entry_id})`,
            seq: expectedSeq,
          });
        }

        const payload = row.payload;
        const { entry_hash: _omit, ...rest } = payload as Record<string, unknown>;
        const recomputed = computeEntryHash(canonicalize(rest));
        if (recomputed !== row.entry_hash) {
          return fail(opts, entriesChecked, checkpointsChecked, warnings, {
            kind: "entry_hash_mismatch",
            detail: `recomputed ${recomputed} but stored ${row.entry_hash}`,
            seq,
          });
        }

        // column ↔ payload consistency
        const bad =
          payload.seq !== seq
            ? "seq"
            : payload.entry_hash !== row.entry_hash
              ? "entry_hash"
              : payload.prev_hash !== row.prev_hash
                ? "prev_hash"
                : payload.kind !== row.kind
                  ? "kind"
                  : row.kind === "VERDICT" &&
                      row.params_hash !== (payload as any).action?.params_hash
                    ? "params_hash"
                    : null;
        if (bad) {
          return fail(opts, entriesChecked, checkpointsChecked, warnings, {
            kind: "column_payload_mismatch",
            detail: `column/payload disagree on '${bad}'`,
            seq,
          });
        }

        if (row.prev_hash !== prevHash) {
          return fail(opts, entriesChecked, checkpointsChecked, warnings, {
            kind: "prev_hash_break",
            detail: `prev_hash ${row.prev_hash} but predecessor entry_hash was ${prevHash}`,
            seq,
          });
        }

        prevHash = row.entry_hash;
        expectedSeq++;
        entriesChecked++;
      }
      cursor = Number(res.rows[res.rows.length - 1]!.seq) + 1;
    }

    const maxSeq = expectedSeq - 1;

    // --- Step 3: checkpoints (signature first, then Merkle root) ---
    const cps = await client.query<{
      id: string;
      seq_from: string;
      seq_to: string;
      merkle_root: string;
      signature: string;
      created_at: string;
    }>(
      `SELECT id, seq_from, seq_to, merkle_root, signature,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM checkpoints WHERE tenant_id = $1 ORDER BY seq_from ASC`,
      [opts.tenant],
    );

    for (const cp of cps.rows) {
      const seqFrom = Number(cp.seq_from);
      const seqTo = Number(cp.seq_to);

      if (opts.publicKeyPem) {
        const signed = canonicalize({
          tenant_id: opts.tenant,
          seq_from: seqFrom,
          seq_to: seqTo,
          merkle_root: cp.merkle_root,
          created_at: cp.created_at,
        });
        if (!verifyEd25519(opts.publicKeyPem, signed, cp.signature)) {
          return fail(opts, entriesChecked, checkpointsChecked, warnings, {
            kind: "checkpoint_signature_invalid",
            detail: `Ed25519 signature does not verify for checkpoint ${cp.id}`,
            checkpointId: cp.id,
          });
        }
      } else {
        warnings.push("no public key supplied — checkpoint signatures not verified");
      }

      const range = await client.query<{ entry_hash: string }>(
        "SELECT entry_hash FROM ledger_entries WHERE tenant_id = $1 AND seq >= $2 AND seq <= $3 ORDER BY seq ASC",
        [opts.tenant, seqFrom, seqTo],
      );
      const expectedCount = seqTo - seqFrom + 1;
      if (range.rowCount !== expectedCount) {
        return fail(opts, entriesChecked, checkpointsChecked, warnings, {
          kind: "checkpoint_missing_entries",
          detail: `checkpoint ${cp.id} covers ${expectedCount} entries but ${range.rowCount} present (truncation?)`,
          checkpointId: cp.id,
        });
      }
      const root = merkleRootHex(range.rows.map((r) => leafFromEntryHash(r.entry_hash)));
      if (root !== cp.merkle_root) {
        return fail(opts, entriesChecked, checkpointsChecked, warnings, {
          kind: "checkpoint_root_mismatch",
          detail: `recomputed Merkle root ${root} but checkpoint stored ${cp.merkle_root}`,
          checkpointId: cp.id,
        });
      }
      checkpointsChecked++;
    }

    // --- Step 3b: anchors comparison / truncation (T6) ---
    if (opts.anchors && opts.anchors.length) {
      const mine = opts.anchors.filter((a) => a.tenant_id === opts.tenant);
      const maxAnchorSeqTo = Math.max(...mine.map((a) => a.seq_to));
      if (maxAnchorSeqTo > maxSeq) {
        return fail(opts, entriesChecked, checkpointsChecked, warnings, {
          kind: "truncation",
          detail: `anchors.log references seq_to ${maxAnchorSeqTo} but the ledger's max seq is ${maxSeq}`,
          seq: maxSeq + 1,
        });
      }
      const byId = new Map(cps.rows.map((c) => [c.id, c]));
      for (const a of mine) {
        const db = byId.get(a.id);
        if (!db) {
          return fail(opts, entriesChecked, checkpointsChecked, warnings, {
            kind: "anchor_missing_checkpoint",
            detail: `anchors.log has checkpoint ${a.id} (seq ${a.seq_from}-${a.seq_to}) absent from the DB`,
            checkpointId: a.id,
          });
        }
        if (db.merkle_root !== a.merkle_root || db.signature !== a.signature) {
          return fail(opts, entriesChecked, checkpointsChecked, warnings, {
            kind: "anchor_mismatch",
            detail: `DB checkpoint ${a.id} differs from the anchors.log record`,
            checkpointId: a.id,
          });
        }
      }
    }

    return {
      ok: true,
      tenant: opts.tenant,
      entriesChecked,
      checkpointsChecked,
      warnings,
    };
  } finally {
    await client.end();
  }
}

function fail(
  opts: VerifyOptions,
  entriesChecked: number,
  checkpointsChecked: number,
  warnings: string[],
  failure: Failure,
): VerifyReport {
  return {
    ok: false,
    tenant: opts.tenant,
    entriesChecked,
    checkpointsChecked,
    warnings,
    failure,
  };
}

// Re-export for tooling/tests that want the primitives.
export { sha256Hex, canonicalize };
