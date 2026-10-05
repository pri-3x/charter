import type { FastifyInstance } from "fastify";
import type { Pool } from "../db.js";
import { resolveAuth } from "../auth.js";
import { handleRpc } from "./server.js";
import { LATEST_PROTOCOL_VERSION, RPC, err, parseRequest } from "./protocol.js";
import type { RpcError, RpcResponse } from "./protocol.js";

/**
 * MCP over streamable HTTP: one endpoint, POST, JSON in and JSON out.
 *
 * No SSE and no session store. The spec allows a server to answer a POST with a single JSON
 * response, and every call Charter serves is request/response — a verdict is one round trip, and a
 * held action returns immediately with a hold id rather than streaming progress for four hours.
 * Adding a stream would be adding a thing to go wrong in exchange for nothing.
 *
 * Auth is the agent's own API key as a bearer token, so an MCP client is configured exactly like
 * any other Charter caller and the registry, charter and authority all apply unchanged.
 */
export interface McpRouteDeps {
  pool: Pool;
  adminKey: string;
  custodyEnabled: boolean;
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const unauthorized = (): RpcResponse =>
    err(null, RPC.INVALID_REQUEST, "unauthorized: send the agent's API key as a bearer token");

  app.post("/mcp", async (req, reply) => {
    reply.header("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);

    const auth = await resolveAuth(deps.pool, req.headers.authorization, deps.adminKey);
    if (auth.kind !== "agent") {
      // 401 so an MCP client's auth handling sees it, with a JSON-RPC body so a client that only
      // reads the body still gets a sentence it can show.
      return reply.code(401).send(unauthorized());
    }
    const authorization = req.headers.authorization!;

    // A batch is an array; the spec allows it and clients do send one on startup.
    const batch = Array.isArray(req.body) ? req.body : [req.body];
    if (batch.length === 0) {
      return reply.code(400).send(err(null, RPC.INVALID_REQUEST, "empty batch"));
    }

    const responses: RpcResponse[] = [];
    for (const item of batch) {
      const parsed = parseRequest(item);
      if ("code" in parsed) {
        const e = parsed as RpcError;
        responses.push(err(null, e.code, e.message));
        continue;
      }
      try {
        const res = await handleRpc(app, { pool: deps.pool, custodyEnabled: deps.custodyEnabled }, parsed, auth.agent, authorization);
        if (res) responses.push(res);
      } catch (e) {
        req.log.error({ err: e, method: parsed.method }, "mcp request failed");
        // Fail closed and say so: an exception must never read as a tool that quietly did nothing.
        responses.push(err(parsed.id ?? null, RPC.INTERNAL_ERROR, "the gate failed to handle this request"));
      }
    }

    // Notifications only ⇒ nothing to answer. 202 is what the spec asks for.
    if (responses.length === 0) return reply.code(202).send();
    return reply.code(200).send(Array.isArray(req.body) ? responses : responses[0]);
  });

  // Clients probe GET to open a server-initiated stream. Charter never initiates, so say so rather
  // than leaving a connection open that will never carry anything.
  app.get("/mcp", async (_req, reply) =>
    reply.code(405).header("allow", "POST").send({
      error: "this MCP server is request/response only; use POST",
    }),
  );
}
