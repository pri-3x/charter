import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "@charter/shared";
import { buildApp, makePool } from "@charter/gate";
import type { Pool } from "@charter/gate";

/**
 * MCP gateway (C14–C24).
 *
 * The claim being tested is not "the server speaks JSON-RPC" — it is that a call arriving over MCP
 * is governed by exactly the same machinery as one arriving over /v1/actions/check. So every test
 * here asserts on the GATE's behaviour through the MCP doorway: what the upstream tool received,
 * what the ledger recorded, and what the model is told when the answer is no.
 */

loadEnv();
const seed: { tenant: string; adminKey: string; agents: Record<string, string> } = JSON.parse(
  readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8"),
);

const AGENT = "refunds-agent";
const SECRET = "sk_live_mcp_" + randomBytes(6).toString("hex");
const CREDENTIAL_KEY = randomBytes(32);

let pool: Pool;
let app: FastifyInstance;
let upstream: Server;
let upstreamUrl: string;
const received: Array<{ auth: string | undefined; body: unknown }> = [];

const agentAuth = { authorization: `Bearer ${seed.agents[AGENT]}` };
const adminAuth = { authorization: `Bearer ${seed.adminKey}` };

let rpcId = 0;
async function rpc(method: string, params?: unknown, headers = agentAuth) {
  const res = await app.inject({
    method: "POST", url: "/mcp",
    headers: { ...headers, "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) },
  });
  return { status: res.statusCode, body: res.statusCode === 202 ? null : res.json() };
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ refund_id: "rf_mcp", settled: true }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/refund`;

  pool = makePool(process.env.DATABASE_URL!);
  app = await buildApp(
    { pool, adminKey: seed.adminKey, credentialKey: CREDENTIAL_KEY, allowLoopbackEgress: true },
    { logger: false },
  );
  await app.ready();

  await app.inject({
    method: "POST", url: "/v1/credentials", headers: adminAuth,
    payload: {
      tool: "refund", endpoint_url: upstreamUrl, method: "POST", auth_scheme: "bearer",
      secret: SECRET, by_principal: "user:monty@acme.co",
      title: "Refund a customer",
      description: "Refunds money to a customer for an order.",
      input_schema: {
        type: "object",
        properties: {
          amount: { type: "integer", description: "Amount in paise" },
          currency: { type: "string" },
        },
        required: ["amount", "currency"],
      },
    },
  });
});

afterAll(async () => {
  await app.inject({
    method: "POST", url: "/v1/credentials/refund/revoke", headers: adminAuth,
    payload: { by_principal: "user:monty@acme.co" },
  });
  await app.close();
  await pool.end();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("protocol", () => {
  it("C14 initialize negotiates a version and names itself", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(body.result.protocolVersion).toBe("2025-03-26"); // the client's, since we speak it
    expect(body.result.serverInfo.name).toBe("charter");
    expect(body.result.capabilities.tools).toBeTruthy();
  });

  it("C15 falls back to its own newest version for one it does not speak", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("C16 answers a notification with 202 and no body", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp", headers: { ...agentAuth, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
  });

  it("C17 refuses an unauthenticated client", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp", headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/bearer token/);
  });

  it("C18 rejects a malformed request without crashing", async () => {
    const res = await app.inject({
      method: "POST", url: "/mcp", headers: { ...agentAuth, "content-type": "application/json" },
      payload: { jsonrpc: "1.0", id: 1, method: "tools/list" },
    });
    expect(res.json().error.code).toBe(-32600);
  });
});

describe("tools/list", () => {
  it("C19 advertises only tools this agent may call AND Charter holds a key for", async () => {
    const { body } = await rpc("tools/list");
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("refund");
    expect(names).toContain("charter_await_approval");
    // The agent's grant forbids payouts, and no credential exists for them either.
    expect(names).not.toContain("initiate_payout");
  });

  it("C20 carries the schema a model needs to call it correctly", async () => {
    const { body } = await rpc("tools/list");
    const refund = body.result.tools.find((t: { name: string }) => t.name === "refund");
    expect(refund.description).toMatch(/Refunds money/);
    expect(refund.inputSchema.required).toEqual(["amount", "currency"]);
  });
});

describe("tools/call goes through the real gate", () => {
  it("C21 ALLOW: the upstream is called with Charter's credential, not the agent's", async () => {
    received.length = 0;
    const { body } = await rpc("tools/call", {
      name: "refund", arguments: { amount: 20000, currency: "INR" },
    });
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].text).toContain("rf_mcp");
    expect(body.result._meta.charter.verdict).toBe("ALLOW");

    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe(`Bearer ${SECRET}`);
    expect(received[0]!.body).toEqual({ amount: 20000, currency: "INR" });
    // And the secret is not in anything the model sees.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("C22 DENY comes back as a readable result, not a protocol error", async () => {
    received.length = 0;
    const { body } = await rpc("tools/call", {
      name: "delete_record", arguments: { record_id: "C-1", record_type: "customer" },
    });
    // Not advertised, so refused before it is attempted — and the upstream sees nothing.
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not a tool this agent may use/);
    expect(received).toHaveLength(0);
  });

  it("C23 ESCALATE tells the model to wait rather than retry", async () => {
    received.length = 0;
    const { body } = await rpc("tools/call", {
      name: "refund", arguments: { amount: 8_000_000, currency: "INR" },
    });
    expect(body.result.isError).toBe(true);
    const text: string = body.result.content[0].text;
    expect(text).toMatch(/holding this refund call for human approval/);
    expect(text).toMatch(/Do not retry the original call/);
    expect(body.result._meta.charter.hold_id).toBeTruthy();
    expect(received).toHaveLength(0); // nothing left the gate
  });

  it("C24 an approved hold executes once, with the params from the ledger", async () => {
    received.length = 0;
    const held = await rpc("tools/call", {
      name: "refund", arguments: { amount: 7_000_000, currency: "INR" },
    });
    const holdId = held.body.result._meta.charter.hold_id;

    const pending = await rpc("tools/call", {
      name: "charter_await_approval", arguments: { hold_id: holdId },
    });
    expect(pending.body.result.content[0].text).toMatch(/Still pending/);
    expect(received).toHaveLength(0);

    await pool.query("UPDATE holds SET status='APPROVED', decided_by=$2 WHERE id=$1", [
      holdId, "user:monty@acme.co",
    ]);
    const done = await rpc("tools/call", {
      name: "charter_await_approval", arguments: { hold_id: holdId },
    });
    expect(done.body.result.isError).toBeUndefined();
    expect(received).toHaveLength(1);
    // The amount that was APPROVED, not one the model could have substituted.
    expect((received[0]!.body as { amount: number }).amount).toBe(7_000_000);

    // And only once.
    const again = await rpc("tools/call", {
      name: "charter_await_approval", arguments: { hold_id: holdId },
    });
    expect(again.body.result.isError).toBe(true);
    expect(received).toHaveLength(1);
  });
});
