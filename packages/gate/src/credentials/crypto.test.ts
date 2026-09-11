import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { loadCredentialKey, seal, open, fingerprint, CredentialKeyError } from "./crypto.js";
import type { EgressBinding } from "./crypto.js";

const KEY = randomBytes(32);
const K64 = KEY.toString("base64");
const B: EgressBinding = {
  tenant: "acme",
  tool: "refund",
  endpointUrl: "https://api.example.test/refund",
  method: "POST",
  authScheme: "bearer",
};

describe("credential crypto", () => {
  it("round-trips a secret", () => {
    const s = "sk_live_51H8xQ2abcdefGHIJK";
    expect(open(KEY, seal(KEY, s, B), B)).toBe(s);
  });

  it("never puts the plaintext in the ciphertext", () => {
    const s = "sk_live_verydistinctivevalue";
    const sealed = seal(KEY, s, B);
    expect(sealed.ct.toString("utf8")).not.toContain(s);
    expect(sealed.ct.toString("hex")).not.toContain(Buffer.from(s).toString("hex"));
  });

  it("gives a different ciphertext each time (fresh IV)", () => {
    const a = seal(KEY, "same", B);
    const b = seal(KEY, "same", B);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ct.equals(b.ct)).toBe(false);
    expect(a.fingerprint).toBe(b.fingerprint); // but it is the same secret, and says so
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const sealed = seal(KEY, "sk_live_x", B);
    sealed.ct[0] = (sealed.ct[0] ?? 0) ^ 0xff;
    expect(() => open(KEY, sealed, B)).toThrow();
  });

  it("refuses a tampered tag", () => {
    const sealed = seal(KEY, "sk_live_x", B);
    sealed.tag[0] = (sealed.tag[0] ?? 0) ^ 0xff;
    expect(() => open(KEY, sealed, B)).toThrow();
  });

  it("refuses the wrong key", () => {
    expect(() => open(randomBytes(32), seal(KEY, "sk_live_x", B), B)).toThrow();
  });

  it("refuses to decrypt if the destination was edited in the database", () => {
    // The whole point of binding the descriptor as AAD: endpoint_url is a plaintext column, so
    // repointing it must destroy the credential rather than redirect it.
    const sealed = seal(KEY, "sk_live_x", B);
    expect(() => open(KEY, sealed, { ...B, endpointUrl: "https://attacker.test/collect" })).toThrow();
    expect(() => open(KEY, sealed, { ...B, method: "GET" })).toThrow();
    expect(() => open(KEY, sealed, { ...B, authScheme: "header" })).toThrow();
    expect(() => open(KEY, sealed, { ...B, tool: "initiate_payout" })).toThrow();
    expect(() => open(KEY, sealed, { ...B, tenant: "other-tenant" })).toThrow();
    expect(open(KEY, sealed, { ...B })).toBe("sk_live_x"); // unchanged descriptor still opens
  });

  it("separates binding fields unambiguously", () => {
    // ("a","bc") and ("ab","c") must not canonicalise to the same AAD.
    const s1 = seal(KEY, "x", { ...B, tenant: "a", tool: "bc" });
    expect(() => open(KEY, s1, { ...B, tenant: "ab", tool: "c" })).toThrow();
  });

  it("fingerprints the secret, not the ciphertext", () => {
    expect(fingerprint("a")).toBe(fingerprint("a"));
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
    expect(fingerprint("sk_live_x")).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("fails closed on a missing or malformed key", () => {
    expect(() => loadCredentialKey(undefined)).toThrow(CredentialKeyError);
    expect(() => loadCredentialKey("")).toThrow(CredentialKeyError);
    expect(() => loadCredentialKey("   ")).toThrow(CredentialKeyError);
    expect(() => loadCredentialKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("accepts a well-formed key", () => {
    expect(loadCredentialKey(K64).equals(KEY)).toBe(true);
  });
});
