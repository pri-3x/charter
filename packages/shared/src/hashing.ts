import { createHash } from "node:crypto";
import { canonicalize } from "./jcs.js";

/** All hashes in Mandate are stored/compared with this prefix (see SPEC 4.1 payload example). */
export const HASH_PREFIX = "sha256:";

/** Raw SHA-256 hex digest of a UTF-8 string or Buffer. No prefix. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 digest as a `sha256:<hex>` token, the canonical on-the-wire form. */
export function sha256Token(data: string | Buffer): string {
  return HASH_PREFIX + sha256Hex(data);
}

/** `sha256:<hex>` over the JCS canonicalization of a value (used for params_hash, doc reuse). */
export function jcsHashToken(value: unknown): string {
  return sha256Token(canonicalize(value));
}

/**
 * Genesis prev_hash for a tenant's chain (DECISIONS D4): SHA-256 of the UTF-8 string
 * `MANDATE_GENESIS:<tenant_id>`, as a token.
 */
export function genesisPrevHash(tenantId: string): string {
  return sha256Token(`MANDATE_GENESIS:${tenantId}`);
}

/**
 * entry_hash (DECISIONS D3): `sha256:<hex>` over JCS of the entry object with the `entry_hash`
 * field absent. Everything else — including seq, prev_hash, ts — participates in the hash.
 */
export function computeEntryHash(entry: Record<string, unknown>): string {
  const { entry_hash: _omit, ...rest } = entry;
  return sha256Token(canonicalize(rest));
}
