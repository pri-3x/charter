import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Pool } from "./db.js";
import { grantAuthority } from "./registry/store.js";

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
 *   POST /v1/demo/sandbox      hand a visitor a working console: their own agent in the sandbox
 *                              tenant, plus an admin key scoped to that tenant and nothing else
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

  /**
   * Self-serve sandbox access.
   *
   * The console is an operator tool and needs a credential, which left anyone who found it with a
   * locked page and no way forward — "paste a key" is advice only someone who already has one can
   * act on. This hands them one.
   *
   * What a caller gets: a NEW agent of their own inside the sandbox tenant, with its own daily
   * budget, and an admin key scoped to that tenant. Their own agent matters — sharing one meant the
   * first visitor to try a large refund spent the budget and everyone after them saw DENY on a
   * ₹200 refund, which looks like a broken product rather than a working limit.
   *
   * What it is not: access to anything real. The key is tenant-scoped, and the scoping is enforced
   * by pinning rather than by checking (see tenant-scope.ts), so it cannot be pointed at the real
   * tenant even by a route that forgets to look.
   */
  app.post("/v1/demo/sandbox", async (req, reply) => {
    if (!takeToken(req.ip ?? "unknown")) {
      return reply.code(429).send({ error: "too many requests — try again shortly" });
    }

    // A TENANT per visitor, not an agent inside a shared one. Two reasons, both learned by trying
    // the cheaper version first: a policy's `agents` map is the scope check, so an agent created at
    // runtime is unknown to the sandbox policy and every call returns defaults.unknown_agent; and a
    // shared tenant means the first visitor to try an ₹80,000 refund spends the budget, so the next
    // one sees DENY on ₹200 and concludes the product is broken. Their own tenant also means their
    // register is empty except for their agent, which is what makes the first screen legible.
    const suffix = ulid().slice(-8).toLowerCase();
    const tenant = `trial-${suffix}`;
    const agentId = "your-agent";
    const agentKey = `chr_${randomBytes(24).toString("base64url")}`;
    const adminKeyRaw = `chr_ta_${randomBytes(24).toString("base64url")}`;
    const fp = (v: string): string => "sha256:" + createHash("sha256").update(v).digest("hex");
    const day = 86_400_000;

    // The policy the trial runs on, with the tenant and the agent named for this visitor. Read from
    // disk rather than embedded so it stays the same document the sandbox itself uses.
    let yaml: string;
    try {
      yaml = readFileSync(resolve(process.cwd(), "policies/sandbox.yaml"), "utf8");
    } catch {
      return reply.code(503).send({ error: "no sandbox policy is available on this deployment" });
    }
    yaml = yaml.replace(/^tenant:.*$/m, `tenant: ${tenant}`).replace(/\bdemo-agent\b/g, agentId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenant, "Charter Trial"]);
      // Without this row appendEntry throws on the first verdict.
      await client.query("INSERT INTO ledger_seq (tenant_id, last_seq) VALUES ($1, 0)", [tenant]);
      // Two principals: an agent's owner must be a real person in the same tenant, and approving
      // your own request is refused — with one principal nobody could ever approve anything.
      for (const [id, name, roles] of [
        ["user:you@sandbox.test", "You", ["support-lead"]],
        ["user:approver@sandbox.test", "Dana (approver)", ["finance-lead"]],
      ] as Array<[string, string, string[]]>) {
        await client.query(
          "INSERT INTO principals (id, tenant_id, display_name, roles) VALUES ($1,$2,$3,$4)",
          [id, tenant, name, roles],
        );
      }
      await client.query(
        `INSERT INTO policies (tenant_id, version, doc_yaml, doc_hash, status, activated_at)
         VALUES ($1, 1, $2, $3, 'active', now())`,
        [tenant, yaml, fp(yaml)],
      );
      await client.query(
        `INSERT INTO agents (id, tenant_id, name, key_fingerprint, max_autonomy, status,
                             owner_principal, department, purpose, approver_chain, expires_at)
         VALUES ($1,$2,$3,$4,'ALLOW','ACTIVE',$5,$6,$7,$8, now() + interval '7 days')`,
        [
          agentId, tenant, "Your Agent", fp(agentKey), "user:you@sandbox.test",
          "Customer Support", "Handles refunds and customer email.", ["role:finance-lead"],
        ],
      );
      await client.query(
        "INSERT INTO tenant_admin_keys (fingerprint, tenant_id, label) VALUES ($1,$2,$3)",
        [fp(adminKeyRaw), tenant, `self-serve ${suffix}`],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // The grant goes through the real path so it writes an AUTHORITY_GRANTED entry — the visitor's
    // chain should look like a real one from its very first entry.
    const grant = await grantAuthority(pool, {
      tenant,
      agentId,
      grantorPrincipal: "user:approver@sandbox.test",
      validFrom: new Date(Date.now() - day).toISOString(),
      validUntil: new Date(Date.now() + 7 * day).toISOString(),
      budgetMinor: 10_000_000, // ₹1,00,000/day — every rule reachable without running out
      budgetCurrency: "INR",
      budgetWindowMinutes: 1440,
      allowedTools: ["refund", "send_email", "lookup_order", "update_record"],
      forbiddenOps: ["initiate_payout", "run_payroll", "production_db_query"],
      ref: `trial-${suffix}`,
    });
    if (!grant.ok) return reply.code(500).send({ error: "could not grant authority" });

    return reply.code(200).send({
      tenant,
      admin_key: adminKeyRaw,
      agent_id: agentId,
      agent_key: agentKey,
      expires_in_days: 7,
    });
  });
}
