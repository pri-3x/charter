import { readFileSync, appendFileSync } from "node:fs";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { ulid } from "ulid";
import { canonicalize } from "@charter/shared";
import type { Pool } from "./db.js";
import { leafFromEntryHash, merkleRootHex } from "./merkle.js";

/** Signs the JCS of a checkpoint payload with Ed25519, returning base64 (D5). */
export interface Signer {
  sign(message: string): string;
}

export function loadSigner(pemPath: string): Signer {
  return signerFromPem(readFileSync(pemPath, "utf8"));
}

/**
 * Signer from the PEM itself rather than a path. Serverless hosts have no writable filesystem and no
 * place to put a key file, so there the private key arrives as an environment variable instead.
 */
/**
 * Normalise a PEM that has been through an environment-variable field.
 *
 * A PEM is multi-line and almost every deployment UI mangles that: some store the literal two
 * characters `\` `n`, some strip the newlines entirely, some arrive base64-wrapped. OpenSSL then
 * fails with `DECODER routines::unsupported`, which says nothing about newlines and sends people
 * hunting for a key-format problem they do not have. Accept the common manglings instead — the
 * bytes are identical either way, and the alternative is an operator re-pasting a private key into
 * a web form until it takes.
 */
export function normalizePem(raw: string): string {
  let pem = raw.trim();

  // Whole thing base64-encoded (a common way to dodge the newline problem entirely).
  if (!pem.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(pem, "base64").toString("utf8");
      if (decoded.includes("-----BEGIN")) pem = decoded.trim();
    } catch {
      /* not base64; fall through and let createPrivateKey report it */
    }
  }

  // Literal backslash-n (JSON-escaped), and CRLF from a Windows clipboard.
  pem = pem.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n");

  // Newlines stripped altogether: rebuild the armour. The body is base64, so it has no spaces of
  // its own — every space between the header and footer was a newline.
  if (!pem.includes("\n")) {
    const m = /^(-----BEGIN [A-Z ]+-----)\s*(.*?)\s*(-----END [A-Z ]+-----)$/.exec(pem);
    if (m) {
      const body = m[2]!.replace(/\s+/g, "");
      const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
      pem = `${m[1]}\n${wrapped}\n${m[3]}`;
    }
  }
  return pem.endsWith("\n") ? pem : pem + "\n";
}

export function signerFromPem(pem: string): Signer {
  const key = createPrivateKey(normalizePem(pem));
  return { sign: (message) => cryptoSign(null, Buffer.from(message, "utf8"), key).toString("base64") };
}

export interface Checkpoint {
  id: string;
  tenant_id: string;
  seq_from: number;
  seq_to: number;
  merkle_root: string;
  created_at: string;
  signature: string;
}

/** Append a signed checkpoint as one JSON line to the out-of-band anchors log (D5). */
export function makeAnchorAppender(path: string): (cp: Checkpoint) => void {
  return (cp) => appendFileSync(path, JSON.stringify(cp) + "\n");
}

/**
 * Seal all un-checkpointed entries for a tenant into one signed Merkle checkpoint (SPEC 4.3).
 * Crash-safe: the batch starts just after the last checkpoint's seq_to. Returns null if nothing is
 * pending. The 5-min / 1,000-entry cadence (D5) is driven by the caller (server interval).
 */
export async function createPendingCheckpoint(
  pool: Pool,
  signer: Signer,
  tenant: string,
  onAnchor?: (cp: Checkpoint) => void,
): Promise<Checkpoint | null> {
  const last = await pool.query<{ s: string }>(
    "SELECT COALESCE(MAX(seq_to), 0) AS s FROM checkpoints WHERE tenant_id = $1",
    [tenant],
  );
  const from = Number(last.rows[0]!.s) + 1;

  const rows = await pool.query<{ seq: string; entry_hash: string }>(
    "SELECT seq, entry_hash FROM ledger_entries WHERE tenant_id = $1 AND seq >= $2 ORDER BY seq ASC",
    [tenant, from],
  );
  if (rows.rowCount === 0) return null;

  const seqFrom = Number(rows.rows[0]!.seq);
  const seqTo = Number(rows.rows[rows.rows.length - 1]!.seq);
  const leaves = rows.rows.map((r) => leafFromEntryHash(r.entry_hash));
  const merkleRoot = merkleRootHex(leaves);

  const tsRes = await pool.query<{ ts: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts`,
  );
  const createdAt = tsRes.rows[0]!.ts;

  // The signed payload — key order is irrelevant (JCS sorts); the verifier rebuilds this exactly.
  const payload = {
    tenant_id: tenant,
    seq_from: seqFrom,
    seq_to: seqTo,
    merkle_root: merkleRoot,
    created_at: createdAt,
  };
  const signature = signer.sign(canonicalize(payload));
  const id = ulid();

  await pool.query(
    `INSERT INTO checkpoints (id, tenant_id, seq_from, seq_to, merkle_root, signature, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [id, tenant, seqFrom, seqTo, merkleRoot, signature, createdAt],
  );

  const checkpoint: Checkpoint = { id, ...payload, signature };
  if (onAnchor) onAnchor(checkpoint);
  return checkpoint;
}
