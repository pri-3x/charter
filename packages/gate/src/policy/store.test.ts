import { describe, it, expect, vi } from "vitest";
import { PolicyStore } from "./store.js";

const YAML = `
tenant: t
defaults: { unknown_tool: DENY, unknown_agent: DENY }
agents: { a: { allowed_tools: [refund], max_autonomy: ALLOW } }
rules:
  - { id: R1, when: { tool: refund }, verdict: ALLOW }
`;

/** A pool stand-in that counts queries and can change its answer between them. */
function fakePool(rows: () => unknown[]) {
  let calls = 0;
  return {
    pool: { query: async () => { calls++; return { rows: rows(), rowCount: rows().length }; } },
    get calls() { return calls; },
  };
}

describe("PolicyStore caching", () => {
  it("serves from cache within the TTL (one query, not two)", async () => {
    const f = fakePool(() => [{ version: 1, doc_yaml: YAML, doc_hash: "sha256:x" }]);
    const s = new PolicyStore(f.pool as never, { ttlMs: 60_000 });
    await s.getActive("t");
    await s.getActive("t");
    expect(f.calls).toBe(1);
  });

  it("caches a MISSING policy too, so a tenant with none does not query every request", async () => {
    const f = fakePool(() => []);
    const s = new PolicyStore(f.pool as never, { ttlMs: 60_000 });
    expect(await s.getActive("t")).toBeNull();
    expect(await s.getActive("t")).toBeNull();
    expect(f.calls).toBe(1);
  });

  it("re-reads after the TTL, so another instance's activation is eventually seen", async () => {
    // The whole reason the TTL exists: invalidate() only clears the instance that served the
    // activation, so every other instance must expire its own copy.
    vi.useFakeTimers();
    try {
      let version = 1;
      const f = fakePool(() => [{ version, doc_yaml: YAML, doc_hash: "sha256:x" }]);
      const s = new PolicyStore(f.pool as never, { ttlMs: 30_000 });

      expect((await s.getActive("t"))!.version).toBe(1);
      version = 2; // another instance activated v2
      vi.advanceTimersByTime(29_000);
      expect((await s.getActive("t"))!.version).toBe(1); // still cached
      vi.advanceTimersByTime(2_000);
      expect((await s.getActive("t"))!.version).toBe(2); // expired, re-read
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate() takes effect immediately on this instance", async () => {
    let version = 1;
    const f = fakePool(() => [{ version, doc_yaml: YAML, doc_hash: "sha256:x" }]);
    const s = new PolicyStore(f.pool as never, { ttlMs: 60_000 });
    expect((await s.getActive("t"))!.version).toBe(1);
    version = 2;
    s.invalidate("t");
    expect((await s.getActive("t"))!.version).toBe(2);
  });

  it("caches per tenant, not globally", async () => {
    const f = fakePool(() => [{ version: 1, doc_yaml: YAML, doc_hash: "sha256:x" }]);
    const s = new PolicyStore(f.pool as never, { ttlMs: 60_000 });
    await s.getActive("t1");
    await s.getActive("t2");
    expect(f.calls).toBe(2);
  });
});
