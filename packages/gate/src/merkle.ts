import { createHash } from "node:crypto";

/**
 * Merkle tree over ledger entry hashes (DECISIONS D5). Canonical convention (the verifier
 * re-implements this identically and independently):
 *   - Leaf i = the 32 RAW bytes of entry_hash[i] (hex-decoded, "sha256:" prefix stripped), in seq order.
 *   - Parent = SHA-256(left_bytes ‖ right_bytes).
 *   - An odd trailing node at a level is PROMOTED unchanged (not duplicated).
 *   - A single leaf is its own root.
 *   - merkle_root is serialized as lowercase hex (64 chars).
 */

export function leafFromEntryHash(token: string): Buffer {
  return Buffer.from(token.replace(/^sha256:/, ""), "hex");
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

/** Compute the Merkle root over leaves (raw 32-byte buffers). Returns lowercase hex. */
export function merkleRootHex(leaves: Buffer[]): string {
  if (leaves.length === 0) throw new Error("merkleRootHex: no leaves");
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256(Buffer.concat([level[i]!, level[i + 1]!])));
      else next.push(level[i]!); // odd node promoted
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

export interface ProofStep {
  hash: string; // sibling hash, hex
  side: "L" | "R"; // side of the SIBLING relative to the running hash
}

/** Build the inclusion proof path for the leaf at `index`. */
export function merkleProof(leaves: Buffer[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error("merkleProof: index out of range");
  const path: ProofStep[] = [];
  let idx = index;
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (idx === i) path.push({ hash: level[i + 1]!.toString("hex"), side: "R" });
        else if (idx === i + 1) path.push({ hash: level[i]!.toString("hex"), side: "L" });
        next.push(sha256(Buffer.concat([level[i]!, level[i + 1]!])));
      } else {
        next.push(level[i]!); // odd promoted; no sibling step for idx === i
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return path;
}
