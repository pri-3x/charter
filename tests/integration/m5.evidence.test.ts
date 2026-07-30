import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "@mandate/shared";
import { buildApp, makePool } from "@mandate/gate";
import type { Pool } from "@mandate/gate";

/**
 * Attestation pack + live stream (Charter §5.5).
 *
 * The pack is the artifact a compliance officer hands an auditor, so these tests care about two
 * things above all: that the numbers come from the real ledger, and that the pack is honest about
 * what it does NOT cover (an unsealed tail, the SDK-integration limitation).
 */

loadEnv();

interface Seed {
  tenant: string;
  agentId: string;
  apiKey: string;
  adminKey: string;
  agents: Record<string, string>;
}
const seed: Seed = JSON.parse(readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8"));

let pool: Pool;
let app: FastifyInstance;
const adminAuth = { authorization: `Bearer ${seed.adminKey}` };

let n = 0;
const idem = (): Record<string, string> => ({ "idempotency-key": `ev-${Date.now()}-${n++}` });

function check(tool: string, params: Record<string, unknown>, principal: string) {
  return app.inject({
    method: "POST",
    url: "/v1/actions/check",
    headers: { authorization: `Bearer ${seed.apiKey}`, ...idem() },
    payload: { tool, params, principal },
  });
}

function pack(query = "") {
  return app.inject({
    method: "GET",
    url: `/v1/attestation?tenant=${encodeURIComponent(seed.tenant)}${query}`,
    headers: adminAuth,
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  pool = makePool(url);
  app = await buildApp({ pool, adminKey: seed.adminKey }, { logger: false });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("attestation pack", () => {
  it("reports verdict counts that match the ledger for the period", async () => {
    // Write one of each shape so the counts cannot pass by accident on an empty ledger.
    await check("refund", { amount: 20_000, currency: "INR" }, "user:att-allow@acme.co");
    await check("delete_record", { record_id: "R-1", record_type: "customer" }, "user:att-deny@acme.co");

    const res = await pack();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const { rows } = await pool.query<{ verdict: string; c: string }>(
      `SELECT payload->>'verdict' AS verdict, count(*)::text AS c
         FROM ledger_entries
        WHERE tenant_id = $1 AND kind = 'VERDICT'
          AND ts >= $2::timestamptz AND ts <= $3::timestamptz
        GROUP BY 1`,
      [seed.tenant, body.header.period.from, body.header.period.to],
    );
    const expected = Object.fromEntries(rows.map((r) => [r.verdict, Number(r.c)]));
    for (const verdict of ["ALLOW", "DENY", "ESCALATE"]) {
      if (expected[verdict] !== undefined) {
        expect(body.enforcement.by_verdict[verdict]).toBe(expected[verdict]);
      }
    }
    expect(body.header.tenant_id).toBe(seed.tenant);
    expect(body.header.policy.doc_hash).toMatch(/^sha256:/);
  });

  it("carries the registry with charters and the grants in force", async () => {
    const body = (await pack()).json();
    const agents: any[] = body.registry.agents;
    expect(agents.length).toBeGreaterThan(0);
    const support = agents.find((a) => a.id === seed.agentId);
    expect(support.charter.owner_principal).toMatch(/^user:/);
    expect(support.charter.department).toBeTruthy();
    expect(support.registry_record_missing).toBe(false);
    // A grant's identity must be in the evidence, or "it acted inside its authority" is unprovable.
    const grants: any[] = support.authorities_in_force;
    expect(grants.length).toBeGreaterThan(0);
    expect(grants[0].doc_hash).toMatch(/^sha256:/);
    expect(grants[0].ref).toMatch(/^auth_/);
    expect(grants[0].budget.currency).toBe("INR");
    expect(grants[0].forbidden_ops).toContain("initiate_payout");
  });

  it("states maker-checker outcomes and proves no self-approval slipped through", async () => {
    const body = (await pack()).json();
    const escalations: any[] = body.maker_checker.escalations;
    for (const e of escalations) {
      if (e.hold_status === "APPROVED" || e.hold_status === "REJECTED") {
        // The decider must never be the initiator (S8) — the pack asserts it per row.
        expect(e.decided_by).not.toBe(e.initiating_principal);
      }
      if (e.hold_status === "EXPIRED") {
        expect(e.decided_by ?? null).toBeNull(); // a timeout denies, with nobody credited
      }
    }
    expect(Array.isArray(body.maker_checker.statements)).toBe(true);
  });

  it("is honest about the unsealed tail rather than implying full coverage", async () => {
    // Fresh entries are chained but not yet sealed (the worker runs every 5 minutes).
    await check("refund", { amount: 1_000, currency: "INR" }, "user:att-tail@acme.co");
    const body = (await pack()).json();
    const cps = body.evidence_integrity.checkpoints;
    expect(body.evidence_integrity.chain.prev_hash_linkage_verified).toBe(true);
    expect(body.evidence_integrity.chain.entry_hash_recomputed).toBe(true);
    // The entry just written cannot be sealed yet, so the pack must name an unsealed range and say
    // how many entries are outside the seal — the whole point is that it does not imply coverage.
    expect(cps.entries_not_sealed).toBeGreaterThan(0);
    expect(cps.uncheckpointed_ranges.length).toBeGreaterThan(0);
    expect(cps.trailing_uncheckpointed.seq_to).toBeGreaterThanOrEqual(
      cps.trailing_uncheckpointed.seq_from,
    );
    expect(cps.entries_sealed + cps.entries_not_sealed).toBe(body.evidence_integrity.chain.entries);
    expect(String(cps.note)).toMatch(/NOT yet/i);
  });

  it("names its own limitations, including the SDK-integration one (D1)", async () => {
    const body = (await pack()).json();
    const text = JSON.stringify(body.limitations).toLowerCase();
    expect(text).toContain("sdk");
    expect(text).toMatch(/d1|proxy/);
    expect(body.control_mapping.map((c: any) => c.framework)).toEqual(
      expect.arrayContaining(["RBI", "EU AI Act", "SOC 2"]),
    );
  });

  it("hashes the evidence, not the moment of rendering — same period, same hash", async () => {
    const from = "2026-07-01T00:00:00.000Z";
    const to = "2026-07-02T00:00:00.000Z"; // a closed window in the past: its evidence cannot change
    const a = (await pack(`&from=${from}&to=${to}`)).json();
    const b = (await pack(`&from=${from}&to=${to}`)).json();
    expect(a.pack_hash).toMatch(/^sha256:/);
    expect(a.pack_hash).toBe(b.pack_hash);
    expect(a.header.generated_at).not.toBe(b.header.generated_at); // the stamp does differ
  });

  it("renders printable self-contained HTML", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/attestation?tenant=${encodeURIComponent(seed.tenant)}&format=html`,
      headers: adminAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain("<title>");
    expect(html).toMatch(/sha256:[0-9a-f]{8}/); // the pack hash is printed in the document
    // Self-contained: nothing to fetch from a network the auditor's machine may not have.
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/);
  });

  it("is admin-only and rejects a malformed period", async () => {
    const asAgent = await app.inject({
      method: "GET",
      url: "/v1/attestation",
      headers: { authorization: `Bearer ${seed.apiKey}` },
    });
    expect(asAgent.statusCode).toBe(401);

    expect((await pack("&from=notadate")).statusCode).toBe(400);
    expect(
      (await pack("&from=2026-07-10T00:00:00.000Z&to=2026-07-01T00:00:00.000Z")).statusCode,
    ).toBe(400);
  });
});

describe("live stream", () => {
  it("delivers entries recorded after the connection, then closes cleanly", async () => {
    const port = await new Promise<number>((res, rej) => {
      app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
        const addr = app.server.address();
        if (typeof addr === "object" && addr) res(addr.port);
        else rej(new Error("no port"));
      }, rej);
    });

    const headSeq = async (): Promise<number> => {
      const { rows } = await pool.query<{ m: string | null }>(
        "SELECT max(seq) AS m FROM ledger_entries WHERE tenant_id = $1",
        [seed.tenant],
      );
      return rows[0]?.m ? Number(rows[0].m) : 0;
    };
    const from = (await headSeq()) + 1;

    const ctrl = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/stream?tenant=${encodeURIComponent(seed.tenant)}&from_seq=${from}`,
      {
        headers: { authorization: `Bearer ${seed.adminKey}` },
        signal: ctrl.signal,
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Cause an entry to exist while the stream is open.
    const written = await check("refund", { amount: 2_500, currency: "INR" }, "user:stream@acme.co");
    const entryId = written.json().entry_id;

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let seen: Record<string, unknown> | null = null;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !seen) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const chunk of buf.split("\n\n")) {
        for (const l of chunk.split("\n")) {
          if (!l.startsWith("data:")) continue;
          try {
            const payload = JSON.parse(l.slice(5).trim());
            if (payload.entry_id === entryId) seen = payload;
          } catch {
            /* heartbeat comment */
          }
        }
      }
    }

    expect(seen).not.toBeNull();
    expect(seen!.kind).toBe("VERDICT");
    expect(seen!.entry_hash).toMatch(/^sha256:/);

    ctrl.abort();
    await reader.cancel().catch(() => {});
  });

  it("refuses an agent key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/stream",
      headers: { authorization: `Bearer ${seed.apiKey}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
