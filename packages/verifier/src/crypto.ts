import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/** Independent hashing + Merkle + Ed25519 for the verifier (D6). Mirrors the gate's D3/D4/D5 rules. */

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Bytes(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function genesisPrevHash(tenantId: string): string {
  return "sha256:" + sha256Hex(`MANDATE_GENESIS:${tenantId}`);
}

/** entry_hash = "sha256:" + SHA-256(JCS(payload without entry_hash)). */
export function computeEntryHash(canonicalJson: string): string {
  return "sha256:" + sha256Hex(canonicalJson);
}

export function leafFromEntryHash(token: string): Buffer {
  return Buffer.from(token.replace(/^sha256:/, ""), "hex");
}

/** Merkle root (lowercase hex) over raw 32-byte leaves; odd trailing node promoted (D5). */
export function merkleRootHex(leaves: Buffer[]): string {
  if (leaves.length === 0) throw new Error("no leaves");
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256Bytes(Buffer.concat([level[i]!, level[i + 1]!])));
      else next.push(level[i]!);
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

export function verifyEd25519(publicKeyPem: string, message: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
