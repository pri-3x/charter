import { describe, it, expect } from "vitest";
import { CUSTOMERS, ORDERS, customer, emailOf, order, principalOf } from "./fixtures.js";
import { BUSINESS_TOOLS, FixtureWorld, TOOL_NAMES, TOOL_SPECS, createRawTools } from "./tools.js";
import { verifyChainLinks, type LedgerEntry } from "./ledger.js";

describe("fixtures", () => {
  it("keeps every order total an integer number of paise", () => {
    for (const o of ORDERS) {
      expect(Number.isInteger(o.totalMinor), `${o.id} total is not an integer`).toBe(true);
      expect(o.totalMinor).toBeGreaterThan(0);
      expect(o.currency).toBe("INR");
    }
  });

  it("points every order at a real customer and uses unique ids", () => {
    const ids = new Set(ORDERS.map((o) => o.id));
    expect(ids.size).toBe(ORDERS.length);
    for (const o of ORDERS) expect(() => customer(o.customerKey)).not.toThrow();
  });

  it("carries the exact amounts the adversarial scenarios need", () => {
    expect(order("ORD-4472").totalMinor).toBe(8_000_000); // A1: Rs 80,000
    expect(order("ORD-4473").totalMinor).toBe(4_000_000); // A2: Rs 40,000
  });

  it("run-scopes principals and emails", () => {
    const c = customer("priya");
    expect(principalOf(c, "k9z")).toBe("user:priya.n+k9z@example.com");
    expect(emailOf(c, "k9z")).toBe("priya.n+k9z@example.com");
  });

  it("gives every customer a CRM record id (the subject of update/delete)", () => {
    for (const c of CUSTOMERS) expect(c.recordId).toMatch(/^CUST-\d+$/);
  });

  it("throws on an unknown fixture rather than returning a blank", () => {
    expect(() => customer("nobody")).toThrow();
    expect(() => order("ORD-0000")).toThrow();
  });
});

describe("tool specs", () => {
  it("declares a spec for every tool, with a strict schema", () => {
    expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const spec of TOOL_SPECS) {
      expect(spec.input_schema.type).toBe("object");
      expect(spec.input_schema.additionalProperties).toBe(false);
      expect(spec.input_schema.required).toBeDefined();
      for (const req of spec.input_schema.required) {
        expect(Object.keys(spec.input_schema.properties)).toContain(req);
      }
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it("tells the model that money is integer paise", () => {
    const refund = TOOL_SPECS.find((t) => t.name === "refund")!;
    expect(JSON.stringify(refund.input_schema)).toContain("paise");
  });

  it("names the four business tools plus the two deliberate probes", () => {
    expect(BUSINESS_TOOLS).toEqual(["refund", "send_email", "lookup_order", "update_record"]);
    expect(TOOL_NAMES).toContain("delete_record");
    expect(TOOL_NAMES).toContain("initiate_payout");
  });
});

describe("raw tools (the unguarded functions A4 bypasses to)", () => {
  it("validates params and refuses a non-integer amount", async () => {
    const raw = createRawTools(new FixtureWorld());
    await expect(raw.refund({ order_id: "ORD-4471", amount: 200.5, currency: "INR", reason: "x" } as never)).rejects.toThrow();
    await expect(raw.refund({ order_id: "nope", amount: 100, currency: "INR", reason: "x" } as never)).rejects.toThrow();
  });

  it("accumulates refunds per order so the fixture world stays coherent", async () => {
    const world = new FixtureWorld();
    const raw = createRawTools(world);
    await raw.refund({ order_id: "ORD-4471", amount: 20_000, currency: "INR", reason: "a" });
    await raw.refund({ order_id: "ORD-4471", amount: 5_000, currency: "INR", reason: "b" });
    expect(world.refundedMinor("ORD-4471")).toBe(25_000);
    const v = await raw.lookup_order({ order_id: "ORD-4471" });
    expect(v.refunded_minor).toBe(25_000);
    expect(v.refundable_minor).toBe(order("ORD-4471").totalMinor - 25_000);
    expect(world.refunds).toHaveLength(2);
  });

  it("succeeds when called directly — that is the A4 / D1 limitation, by design", async () => {
    const world = new FixtureWorld();
    const raw = createRawTools(world);
    const receipt = await raw.refund({ order_id: "ORD-4472", amount: 9_500_000, currency: "INR", reason: "bypass" });
    expect(receipt.status).toBe("SETTLED");
    expect(world.refunds).toHaveLength(1);
  });
});

describe("chain-link verification", () => {
  const entry = (seq: number, prev: string, hash: string): LedgerEntry =>
    ({ seq, prev_hash: prev, entry_hash: hash, entry_id: `E${seq}`, ts: "", tenant: "t", kind: "VERDICT" }) as LedgerEntry;

  it("accepts a well-linked range", () => {
    const res = verifyChainLinks([entry(1, "g", "h1"), entry(2, "h1", "h2"), entry(3, "h2", "h3")]);
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(3);
  });

  it("localizes a prev_hash break to the successor entry", () => {
    const res = verifyChainLinks([entry(1, "g", "h1"), entry(2, "WRONG", "h2")]);
    expect(res.ok).toBe(false);
    expect(res.firstBreakSeq).toBe(2);
  });

  it("catches a seq gap", () => {
    const res = verifyChainLinks([entry(1, "g", "h1"), entry(3, "h1", "h3")]);
    expect(res.ok).toBe(false);
    expect(res.firstBreakSeq).toBe(3);
    expect(res.detail).toContain("seq gap");
  });

  it("treats a single entry as trivially linked", () => {
    expect(verifyChainLinks([entry(9, "x", "y")]).ok).toBe(true);
    expect(verifyChainLinks([]).ok).toBe(true);
  });
});
