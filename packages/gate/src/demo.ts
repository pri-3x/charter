import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import type { Pool } from "./db.js";

/**
 * Public demo endpoints.
 *
 * The landing page needs to show real verdicts to anonymous visitors. It cannot do that the way the
 * local console does — `/v1/dev/credentials` hands out the admin key and every agent key, which is
 * why it is loopback-gated and refuses under NODE_ENV=production. Publishing it would give any
 * visitor full read access to the ledger and the ability to write entries as any agent.
 *
 * So these two endpoints exist instead. The credential stays on the server; the browser only ever
 * names a case by index or asks for the artefact shapes. Both are deliberately narrow:
 *
 *   POST /v1/demo/decide     runs ONE of a fixed set of canned actions through the real
 *                            /v1/actions/check route, in process, holding the agent key server-side
 *   GET  /v1/demo/artefacts  entry hashes, the latest checkpoints and verdict counts — the exact
 *                            fields the ASCII panels draw, and nothing else
 *   GET  /v1/demo/attestation  the HTML evidence pack for the demo tenant's last 30 days
 *
 * `decide` re-enters the real route via app.inject() rather than reimplementing anything, so a demo
 * verdict goes through the same auth, idempotency, policy evaluation and ledger commit as any other
 * call. If the demo says ALLOW, a real ledger entry exists for it.
 */

/** The only actions a visitor can trigger. Fixed on purpose: no caller-supplied params, ever. */
export const DEMO_CASES = [
  { txt: "Refund a customer", tool: "refund", rupees: 200 },
  { txt: "Email the customer", tool: "send_email", rupees: 0 },
  { txt: "Refund a customer", tool: "refund", rupees: 80000 },
  { txt: "Refund a customer", tool: "refund", rupees: 450 },
  { txt: "Pay out to a bank", tool: "initiate_payout", rupees: 500 },
  { txt: "Look up an order", tool: "lookup_order", rupees: 0 },
  { txt: "Delete a record", tool: "delete_record", rupees: 0 },
] as const;

function paramsFor(c: (typeof DEMO_CASES)[number]): Record<string, unknown> {
  const params: Record<string, unknown> = { currency: "INR" };
  if (c.rupees > 0) params.amount = c.rupees * 100;
  if (c.tool === "lookup_order") params.order_id = "ORD-4471";
  if (c.tool === "send_email") params.to = "customer@example.com";
  if (c.tool === "delete_record") {
    params.record_id = "CUST-1";
    params.record_type = "customer";
  }
  return params;
}

/**
 * Per-IP token bucket, in memory.
 *
 * Honest about what this is: on serverless each instance keeps its own counters, so a determined
 * caller spread across instances gets more than the nominal rate. It is a courtesy limit, not a
 * security boundary. The actual containment is structural — the case list is fixed so nothing
 * arbitrary can be written, and the demo agent has its own small daily budget, so sustained abuse
 * exhausts that budget and starts returning DENY rather than costing anything.
 */
const BUCKET_SIZE = 20;
const REFILL_PER_SEC = 0.5;
const buckets = new Map<string, { tokens: number; last: number }>();

function takeToken(ip: string, now = Date.now()): boolean {
  // Bound the map so a flood of distinct IPs cannot grow it without limit.
  if (buckets.size > 5000) buckets.clear();
  const b = buckets.get(ip) ?? { tokens: BUCKET_SIZE, last: now };
  const refill = ((now - b.last) / 1000) * REFILL_PER_SEC;
  b.tokens = Math.min(BUCKET_SIZE, b.tokens + refill);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

export interface DemoDeps {
  pool: Pool;
  adminKey: string;
  /** Key for the agent the demo acts as. Absent ⇒ the endpoints report unavailable, never guess. */
  demoAgentKey?: string;
  tenant: string;
}

export function registerDemoRoutes(app: FastifyInstance, deps: DemoDeps): void {
  const { pool, adminKey, demoAgentKey, tenant } = deps;

  app.post<{ Body: { case?: number } }>("/v1/demo/decide", async (req, reply) => {
    if (!demoAgentKey) {
      return reply.code(503).send({ error: "demo is not configured on this deployment" });
    }
    if (!takeToken(req.ip ?? "unknown")) {
      return reply.code(429).send({ error: "too many demo requests — try again shortly" });
    }

    const i = Number(req.body?.case);
    if (!Number.isInteger(i) || i < 0 || i >= DEMO_CASES.length) {
      return reply.code(400).send({ error: `case must be an integer 0..${DEMO_CASES.length - 1}` });
    }
    const c = DEMO_CASES[i]!;

    const started = Date.now();
    // Re-enter the real route in process. Same auth, same idempotency, same ledger commit.
    const res = await app.inject({
      method: "POST",
      url: "/v1/actions/check",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${demoAgentKey}`,
        "idempotency-key": `demo-${ulid()}`,
      },
      payload: {
        tool: c.tool,
        params: paramsFor(c),
        principal: "user:demo-visitor@usecharter.xyz",
        context: { reasoning: "Triggered from the Charter home page demo." },
      },
    });

    if (res.statusCode !== 200) {
      // Fail closed and say so, rather than dressing an error up as a verdict.
      return reply.code(502).send({ error: "the gate did not return a verdict", status: res.statusCode });
    }
    const body = res.json() as { verdict: string; rule_id?: string; entry_id?: string };
    return reply.code(200).send({
      txt: c.txt,
      tool: c.tool,
      rupees: c.rupees,
      verdict: body.verdict,
      rule_id: body.rule_id ?? null,
      entry_id: body.entry_id ?? null,
      latency_ms: Date.now() - started,
    });
  });

  /**
   * The artefact shapes, without the admin key. Returns only what the panels sample: entry hashes,
   * the newest checkpoints, and verdict tallies. No payloads, no principals, no rule detail — so
   * this cannot become a back door onto the ledger contents.
   */
  app.get("/v1/demo/artefacts", async (req, reply) => {
    if (!takeToken(req.ip ?? "unknown")) {
      return reply.code(429).send({ error: "too many demo requests — try again shortly" });
    }
    const [chain, cps, counts] = await Promise.all([
      pool.query<{ entry_hash: string }>(
        "SELECT entry_hash FROM ledger_entries WHERE tenant_id = $1 ORDER BY seq ASC LIMIT 400",
        [tenant],
      ),
      pool.query(
        `SELECT seq_from::text, seq_to::text, merkle_root, signature
           FROM checkpoints WHERE tenant_id = $1 ORDER BY seq_from ASC`,
        [tenant],
      ),
      pool.query<{ verdict: string; n: string }>(
        `SELECT payload->>'verdict' AS verdict, count(*)::text AS n
           FROM ledger_entries
          WHERE tenant_id = $1 AND payload->>'verdict' IS NOT NULL
          GROUP BY 1`,
        [tenant],
      ),
    ]);

    const tally: Record<string, number> = { ALLOW: 0, DENY: 0, ESCALATE: 0 };
    for (const r of counts.rows) if (r.verdict in tally) tally[r.verdict] = Number(r.n);

    return reply.code(200).send({
      chain: chain.rows,
      checkpoints: cps.rows,
      counts: tally,
      entry_count: chain.rowCount ?? 0,
    });
  });

  /**
   * The evidence pack, for the demo tenant and nobody else.
   *
   * /v1/attestation is admin-only and stays that way. This wraps it with the tenant and the window
   * pinned server-side, so a visitor can open the artefact an auditor receives without the page ever
   * holding the admin key — and cannot point it at another tenant, another window, or another agent.
   * The pack contains hashes, verdicts, rule ids and the public checkpoint signatures for traffic the
   * demo itself generated; there is nothing in it that is not already in /v1/demo/artefacts or on the
   * page. HTML only: the JSON form is the machine artefact and belongs behind the admin key.
   */
  app.get("/v1/demo/attestation", async (req, reply) => {
    if (!takeToken(req.ip ?? "unknown")) {
      return reply.code(429).send({ error: "too many demo requests — try again shortly" });
    }
    // Same re-entry trick as /v1/demo/decide: the real route, with the credential held server-side.
    const res = await app.inject({
      method: "GET",
      url: `/v1/attestation?tenant=${encodeURIComponent(tenant)}&format=html`,
      headers: { authorization: `Bearer ${adminKey}` },
    });
    if (res.statusCode !== 200) {
      return reply.code(502).send({ error: "could not build the pack", status: res.statusCode });
    }
    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(res.body);
  });
}
