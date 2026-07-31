/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * This is the correctness-critical component of Charter (DECISIONS D3): the entry_hash is a
 * SHA-256 over the JCS serialization of a ledger entry, and the independent verifier must derive
 * the exact same bytes from the stored payload. Any divergence breaks the hash chain.
 *
 * Design note — why this leans on the platform:
 *   RFC 8785 defines number and string serialization to be *identical* to ECMAScript's
 *   `ToString(Number)` and JSON string production respectively. Node's `String(n)` and
 *   `JSON.stringify(str)` implement exactly those. So the only thing JCS actually adds on top of
 *   the platform is: (1) deterministic object key ordering (UTF-16 code-unit sort) and
 *   (2) rejection of values JSON tolerates but JCS forbids (NaN/Infinity). We implement those
 *   explicitly and delegate the rest, which is both correct and auditable.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Serialize a number per RFC 8785 §3.2.2.3, i.e. ECMAScript `Number::toString`.
 * `String(n)` is exactly that algorithm. -0 becomes "0" (String(-0) === "0"), and non-finite
 * values are rejected (JSON would silently coerce them to null, which JCS forbids).
 */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`JCS: non-finite number is not serializable: ${n}`);
  }
  return String(n);
}

/**
 * Serialize a string per RFC 8785 §3.2.2.2. This matches ECMAScript JSON string production:
 * short escapes for \" \\ \b \t \n \f \r, \u00XX (lowercase) for other C0 controls, lone
 * surrogates escaped, everything else emitted as literal UTF-8. `JSON.stringify` of a string
 * produces precisely this.
 */
function serializeString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Canonicalize any JSON-compatible value to its RFC 8785 string form.
 * Object members whose values are `undefined`, functions, or symbols are omitted (as JSON.stringify
 * does). Keys are sorted by UTF-16 code unit, which is exactly the default `Array.sort` order on
 * strings — so no custom comparator is needed (and using one risks locale surprises).
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return serializeNumber(value as number);
  if (t === "string") return serializeString(value as string);
  if (t === "bigint") {
    throw new TypeError("JCS: bigint is not supported; convert to number before canonicalizing");
  }
  if (t === "undefined" || t === "function" || t === "symbol") {
    throw new TypeError(`JCS: value of type ${t} is not serializable at top level`);
  }

  if (Array.isArray(value)) {
    return "[" + value.map((el) => canonicalize(el ?? null)).join(",") + "]";
  }

  // plain object
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const members: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    members.push(serializeString(key) + ":" + canonicalize(v));
  }
  return "{" + members.join(",") + "}";
}
