/**
 * RFC 8785 (JCS) canonicalization — INDEPENDENT re-implementation for the verifier (DECISIONS D6).
 * Intentionally does NOT import @charter/shared: the whole point of the verifier is to re-derive
 * the ledger's hashes with a separate implementation. Same spec, different code.
 *
 * RFC 8785 defines number/string serialization to equal ECMAScript ToString(Number) / JSON string
 * production, which Node's String(n) / JSON.stringify(s) implement; JCS adds deterministic key
 * ordering (UTF-16 code-unit sort, i.e. default Array.sort) and rejection of non-finite numbers.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
    return String(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") throw new TypeError("JCS: bigint unsupported");
  if (Array.isArray(value)) {
    return "[" + value.map((el) => canonicalize(el ?? null)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      parts.push(JSON.stringify(k) + ":" + canonicalize(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new TypeError(`JCS: unsupported value of type ${t}`);
}
