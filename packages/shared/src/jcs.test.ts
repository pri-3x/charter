import { describe, it, expect } from "vitest";
import { canonicalize } from "./jcs.js";
import { computeEntryHash, genesisPrevHash, sha256Token } from "./hashing.js";

/** Deterministic PRNG (mulberry32) so property runs are reproducible across machines/CI. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const UNICODE_KEYS = ["α", "z", "a", "Z", "é", "日", " key", "b", "10", "2"];
const STRING_POOL = ["a", "B", "π", "日本", '"quote"', "tab\tnl\n", "\\slash", "😀", ""];

function randomJson(rng: () => number, depth: number): Json {
  const roll = rng();
  if (depth <= 0 || roll < 0.35) {
    const leaf = rng();
    if (leaf < 0.2) return null;
    if (leaf < 0.4) return rng() < 0.5;
    if (leaf < 0.7) {
      const n = Math.floor((rng() - 0.5) * 2_000_000);
      return rng() < 0.3 ? n + Math.round(rng() * 100) / 100 : n;
    }
    return STRING_POOL[Math.floor(rng() * STRING_POOL.length)]!;
  }
  if (roll < 0.65) {
    const len = Math.floor(rng() * 4);
    const arr: Json[] = [];
    for (let i = 0; i < len; i++) arr.push(randomJson(rng, depth - 1));
    return arr;
  }
  const size = Math.floor(rng() * 5);
  const obj: Record<string, Json> = {};
  for (let i = 0; i < size; i++) {
    const key = UNICODE_KEYS[Math.floor(rng() * UNICODE_KEYS.length)]!;
    obj[key] = randomJson(rng, depth - 1);
  }
  return obj;
}

/** Recursively rebuild an object with keys inserted in a shuffled order. */
function shuffleKeys(value: Json, rng: () => number): Json {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, rng));
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }
    const out: Record<string, Json> = {};
    for (const [k, v] of entries) out[k] = shuffleKeys(v, rng);
    return out;
  }
  return value;
}

describe("JCS canonicalize — known vectors", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    expect(canonicalize({ b: 1, a: 2, Z: 3, z: 4 })).toBe('{"Z":3,"a":2,"b":1,"z":4}');
  });

  it("serializes nested structures deterministically", () => {
    const v = { z: [3, 2, 1], a: { d: 1, c: 2 } };
    expect(canonicalize(v)).toBe('{"a":{"c":2,"d":1},"z":[3,2,1]}');
  });

  it("matches RFC 8785 number forms", () => {
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize(1.0)).toBe("1");
    expect(canonicalize(0.1)).toBe("0.1");
    expect(canonicalize(5000000)).toBe("5000000");
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(5e-7)).toBe("5e-7");
    expect(canonicalize(-123.456)).toBe("-123.456");
  });

  it("escapes strings per JSON string production", () => {
    expect(canonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalize("tab\tnl\n")).toBe('"tab\\tnl\\n"');
    // C0 control chars use lowercase \u00XX
    expect(canonicalize(String.fromCharCode(0))).toBe('"\\u0000"');
    expect(canonicalize(String.fromCharCode(0x1f))).toBe('"\\u001f"');
  });

  it("preserves non-ASCII unicode literally (no \\u escaping)", () => {
    expect(canonicalize("日本語")).toBe('"日本語"');
    expect(canonicalize({ café: "π" })).toBe('{"café":"π"}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
  });

  it("omits undefined object members like JSON", () => {
    expect(canonicalize({ a: 1, b: undefined as unknown as number })).toBe('{"a":1}');
  });
});

describe("JCS canonicalize — properties (1000 random values)", () => {
  const rng = mulberry32(0xc0ffee);

  it("is idempotent: parse(canonicalize(x)) canonicalizes identically", () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomJson(rng, 4);
      const once = canonicalize(v);
      const twice = canonicalize(JSON.parse(once));
      expect(twice).toBe(once);
    }
  });

  it("is key-order independent: shuffled-key clones canonicalize identically", () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomJson(rng, 4);
      const shuffled = shuffleKeys(v, rng);
      expect(canonicalize(shuffled)).toBe(canonicalize(v));
    }
  });

  it("round-trips values (semantic equality preserved through canonical form)", () => {
    for (let i = 0; i < 500; i++) {
      const v = randomJson(rng, 4);
      expect(JSON.parse(canonicalize(v))).toEqual(v);
    }
  });
});

describe("hashing helpers", () => {
  it("genesis prev_hash is stable and tenant-specific", () => {
    const a = genesisPrevHash("acme-fintech");
    expect(a).toBe(sha256Token("MANDATE_GENESIS:acme-fintech"));
    expect(a).not.toBe(genesisPrevHash("other-tenant"));
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("computeEntryHash ignores a pre-existing entry_hash field", () => {
    const base = { seq: 1, tenant: "t", verdict: "ALLOW", prev_hash: "sha256:00" };
    const withHash = { ...base, entry_hash: "sha256:doesnotmatter" };
    expect(computeEntryHash(withHash)).toBe(computeEntryHash(base));
  });

  it("computeEntryHash is order-independent over the payload keys", () => {
    const a = { seq: 1, tenant: "t", verdict: "ALLOW", prev_hash: "sha256:00" };
    const b = { prev_hash: "sha256:00", verdict: "ALLOW", tenant: "t", seq: 1 };
    expect(computeEntryHash(a)).toBe(computeEntryHash(b));
  });
});
