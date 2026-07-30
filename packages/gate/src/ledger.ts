import { computeEntryHash, genesisPrevHash } from "@mandate/shared";
import type { EntryKind } from "@mandate/shared";
import type { PoolClient } from "./db.js";

export interface AppendInput {
  tenant: string;
  kind: EntryKind;
  entryId: string;
  /** Kind-specific fields (agent, principal, action, verdict, …). Chain fields are added here. */
  body: Record<string, unknown>;
  /** Value for the params_hash COLUMN (nullable; only VERDICT entries carry it). */
  paramsHash?: string | null;
}

export interface AppendResult {
  seq: number;
  entryId: string;
  entryHash: string;
  prevHash: string;
  ts: string;
  payload: Record<string, unknown>;
}

/**
 * Append one entry to a tenant's hash chain, INSIDE a caller-managed transaction.
 *
 * Steps (DECISIONS D4, SPEC 2.5):
 *   1. SELECT ... FOR UPDATE the per-tenant seq row → serializes appends, assigns monotonic seq.
 *   2. prev_hash = genesis (seq 1) or entry_hash of seq-1.
 *   3. ts from Postgres now() (never app clock; CLAUDE.md) → stored in payload AND ts column.
 *   4. entry_hash = SHA-256 over JCS of the payload with entry_hash absent (D3).
 *   5. INSERT the row (payload + duplicated chain columns for the verifier's column↔payload check).
 *
 * The caller COMMITs. The verdict is only returned to the agent after that COMMIT (core invariant).
 */
export async function appendEntry(
  client: PoolClient,
  input: AppendInput,
): Promise<AppendResult> {
  const { tenant, kind, entryId, body, paramsHash } = input;

  const seqRows = await client.query<{ last_seq: string }>(
    "SELECT last_seq FROM ledger_seq WHERE tenant_id = $1 FOR UPDATE",
    [tenant],
  );
  if (seqRows.rowCount === 0) {
    // Fail closed: no seq row means the tenant is not provisioned.
    throw new Error(`no ledger_seq row for tenant ${tenant}`);
  }
  const seq = Number(seqRows.rows[0]!.last_seq) + 1;
  await client.query("UPDATE ledger_seq SET last_seq = $1 WHERE tenant_id = $2", [seq, tenant]);

  let prevHash: string;
  if (seq === 1) {
    prevHash = genesisPrevHash(tenant);
  } else {
    const prev = await client.query<{ entry_hash: string }>(
      "SELECT entry_hash FROM ledger_entries WHERE tenant_id = $1 AND seq = $2",
      [tenant, seq - 1],
    );
    if (prev.rowCount === 0) throw new Error(`chain gap: missing seq ${seq - 1} for ${tenant}`);
    prevHash = prev.rows[0]!.entry_hash;
  }

  const tsRows = await client.query<{ ts: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts`,
  );
  const ts = tsRows.rows[0]!.ts;

  const payload: Record<string, unknown> = {
    seq,
    entry_id: entryId,
    ts,
    tenant,
    kind,
    ...body,
    prev_hash: prevHash,
  };
  const entryHash = computeEntryHash(payload);
  payload.entry_hash = entryHash;

  await client.query(
    `INSERT INTO ledger_entries
       (tenant_id, seq, entry_id, kind, payload, params_hash, prev_hash, entry_hash, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
    [tenant, seq, entryId, kind, payload, paramsHash ?? null, prevHash, entryHash, ts],
  );

  return { seq, entryId, entryHash, prevHash, ts, payload };
}
