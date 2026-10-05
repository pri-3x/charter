import type { FastifyInstance } from "fastify";
import type { Pool } from "../db.js";
import type { AgentRow } from "../auth.js";
import {
  LATEST_PROTOCOL_VERSION, RPC, err, isNotification, negotiateVersion, ok, errorResult, textResult,
} from "./protocol.js";
import type { RpcRequest, RpcResponse, ToolResult } from "./protocol.js";

/**
 * Charter as an MCP server.
 *
 * The point of this file is what it does NOT do. It holds no policy logic, no ledger writes and no
 * egress: `tools/call` re-enters POST /v1/proxy/:tool in process, so an MCP call goes through the
 * same registry check, authority check, policy evaluation, limit counters, hold creation, ledger
 * commit and credential custody as every other call. There is one implementation of "may this
 * happen", and this is a different doorway onto it, not a second opinion.
 *
 * Why this shape is the adoption story: under Pattern A a team wraps every tool by hand. Here they
 * change a config block. The agent is pointed at Charter, Charter advertises the tools that agent is
 * allowed to use AND holds a credential for, and the agent cannot reach anything else — it has no
 * other credential to reach it with.
 */

export interface McpDeps {
  pool: Pool;
  /** Set when credential custody is configured; without it there is nothing to advertise. */
  custodyEnabled: boolean;
}

interface ToolRow {
  tool: string;
  title: string | null;
  description: string | null;
  input_schema: Record<string, unknown> | null;
}

/**
 * The tools this agent may call: registered with a live credential, inside its authority's
 * allowed_tools, and described well enough for a model to call correctly. A tool missing its
 * schema is withheld rather than advertised — an advertised tool the model cannot call produces a
 * denied action and a confused agent, which is worse than a shorter list.
 */
async function listTools(pool: Pool, agent: AgentRow): Promise<ToolRow[]> {
  const { rows } = await pool.query<ToolRow>(
    `SELECT c.tool, c.title, c.description, c.input_schema
       FROM tool_credentials c
       JOIN authorities a
         ON a.tenant_id = c.tenant_id
        AND a.agent_id  = $2
        AND a.status    = 'ACTIVE'
        AND now() BETWEEN a.valid_from AND a.valid_until
      WHERE c.tenant_id = $1
        AND c.status = 'ACTIVE'
        AND c.input_schema IS NOT NULL
        AND c.tool = ANY (a.allowed_tools)
        AND NOT (c.tool = ANY (a.forbidden_ops))
      ORDER BY c.tool`,
    [agent.tenant_id, agent.id],
  );
  return rows;
}

/** MCP's tool shape. `annotations.readOnlyHint` etc. are advisory; Charter's verdict is not. */
function toMcpTool(r: ToolRow) {
  return {
    name: r.tool,
    title: r.title ?? r.tool,
    description: r.description ?? `Calls ${r.tool} through Charter.`,
    inputSchema: r.input_schema,
  };
}

/**
 * Turn a verdict into something a model can act on.
 *
 * DENY and ESCALATE come back as tool RESULTS with isError, not as JSON-RPC errors: the request was
 * perfectly well-formed, the answer is no (or not yet), and the model needs the reason in its
 * context so it can tell the user the truth rather than retry blindly or invent a success.
 */
function verdictToResult(tool: string, v: {
  verdict: string; rule_id?: string; reason?: string; entry_id?: string;
  hold_id?: string; ttl_minutes?: number; tool_status?: number; tool_response?: unknown;
}): ToolResult {
  if (v.verdict === "ALLOW") {
    const body = typeof v.tool_response === "string" ? v.tool_response : JSON.stringify(v.tool_response, null, 2);
    return textResult(body, { charter: { entry_id: v.entry_id, rule_id: v.rule_id, verdict: "ALLOW" } });
  }
  if (v.verdict === "ESCALATE") {
    return errorResult(
      `Charter is holding this ${tool} call for human approval — it is not done yet.\n` +
        `Hold id: ${v.hold_id}\n` +
        `Rule: ${v.rule_id}\n` +
        (v.ttl_minutes ? `It expires in about ${v.ttl_minutes} minutes.\n` : "") +
        `Tell the person you are helping that it is pending, or call charter_await_approval with ` +
        `that hold id to wait for the decision. Do not retry the original call — a second attempt ` +
        `creates a second request, it does not approve the first.`,
      { charter: { verdict: "ESCALATE", hold_id: v.hold_id, entry_id: v.entry_id, rule_id: v.rule_id } },
    );
  }
  return errorResult(
    `Charter refused this ${tool} call.\n` +
      `Reason: ${v.reason ?? "it is outside what this agent is authorised to do"}\n` +
      `Rule: ${v.rule_id}\n` +
      `This is a decision, not a fault. Do not retry it unchanged; tell the person why, or do ` +
      `something within the agent's authority instead.`,
    { charter: { verdict: "DENY", rule_id: v.rule_id, entry_id: v.entry_id } },
  );
}

/** The one tool Charter adds of its own: waiting on a hold a person has to decide. */
const AWAIT_TOOL = {
  name: "charter_await_approval",
  title: "Wait for a human decision",
  description:
    "Check whether a held action has been approved or rejected yet. Call this with the hold id " +
    "Charter returned. It answers immediately with the current state; it does not block.",
  inputSchema: {
    type: "object",
    properties: { hold_id: { type: "string", description: "The hold id Charter returned." } },
    required: ["hold_id"],
    additionalProperties: false,
  },
} as const;

async function awaitApproval(
  app: FastifyInstance, pool: Pool, agent: AgentRow, authorization: string, holdId: unknown,
): Promise<ToolResult> {
  if (typeof holdId !== "string" || holdId === "") {
    return errorResult("charter_await_approval needs a hold_id (a string).");
  }
  const { rows } = await pool.query<{ status: string }>(
    "SELECT status FROM holds WHERE id = $1 AND tenant_id = $2",
    [holdId, agent.tenant_id],
  );
  const status = rows[0]?.status;
  if (!status) return errorResult(`No hold with id ${holdId} belongs to this agent's tenant.`);

  if (status === "PENDING") {
    return textResult(
      `Still pending — nobody has decided yet. Tell the person it is awaiting approval rather ` +
        `than waiting in a loop; check again later if you are still running.`,
      { charter: { hold_status: "PENDING", hold_id: holdId } },
    );
  }
  if (status !== "APPROVED") {
    return errorResult(
      `That request was ${status.toLowerCase()}. It will not happen. Say so plainly and do not retry it.`,
      { charter: { hold_status: status, hold_id: holdId } },
    );
  }

  // Approved: execute it. The params come from the ledger entry, never from the model — an approval
  // is for what was approved.
  const res = await app.inject({
    method: "POST", url: "/v1/proxy/resume",
    headers: { "content-type": "application/json", authorization },
    payload: { hold_id: holdId },
  });
  const body = res.json() as Record<string, unknown>;
  if (res.statusCode !== 200) {
    return errorResult(
      `The approval could not be carried out: ${String(body.error ?? res.statusCode)}`,
      { charter: { hold_status: "APPROVED", hold_id: holdId } },
    );
  }
  return textResult(
    typeof body.tool_response === "string" ? body.tool_response : JSON.stringify(body.tool_response, null, 2),
    { charter: { verdict: "ALLOW", via: "approval", hold_id: holdId, entry_id: body.entry_id } },
  );
}

export async function handleRpc(
  app: FastifyInstance,
  deps: McpDeps,
  req: RpcRequest,
  agent: AgentRow,
  authorization: string,
): Promise<RpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      return ok(id, {
        protocolVersion: negotiateVersion(req.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "charter", version: "0.1.0", title: "Charter" },
        instructions:
          "Every tool here is checked against a written authority before it runs. A refusal is a " +
          "decision, not a fault: read the reason, tell the person, and do not retry it unchanged. " +
          "A held action is waiting on a named human — use charter_await_approval rather than " +
          "calling again.",
      });
    }

    case "notifications/initialized":
      return null; // a notification: acknowledged by saying nothing

    case "ping":
      return ok(id, {});

    case "tools/list": {
      if (!deps.custodyEnabled) return ok(id, { tools: [] });
      const tools = (await listTools(deps.pool, agent)).map(toMcpTool);
      // The approval tool is only useful once something can be held, so it rides along with the rest.
      return ok(id, { tools: tools.length ? [...tools, AWAIT_TOOL] : [] });
    }

    case "tools/call": {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") {
        return err(id, RPC.INVALID_PARAMS, "tools/call requires a tool name");
      }
      if (name === AWAIT_TOOL.name) {
        return ok(id, await awaitApproval(app, deps.pool, agent, authorization, args.hold_id));
      }

      // Only advertise-able tools are callable: the same query gates both, so a model cannot reach
      // a tool by guessing its name.
      const allowed = await listTools(deps.pool, agent);
      if (!allowed.some((t) => t.tool === name)) {
        return ok(
          id,
          errorResult(
            `${name} is not a tool this agent may use. Charter advertises exactly what it is ` +
              `authorised to call; anything else is refused before it is attempted.`,
          ),
        );
      }

      // THE re-entry. Same auth, same policy, same ledger, same custody as every other call.
      const res = await app.inject({
        method: "POST",
        url: `/v1/proxy/${encodeURIComponent(name)}`,
        headers: {
          "content-type": "application/json",
          authorization,
          "idempotency-key": `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        },
        payload: {
          params: args,
          principal: `agent:${agent.id}`,
          context: { reasoning: "Called over MCP." },
        },
      });

      const body = res.json() as Record<string, unknown>;
      if (res.statusCode === 409) {
        return ok(id, errorResult(`Charter holds no credential for ${name}, so it cannot be called.`));
      }
      if (res.statusCode !== 200) {
        return ok(id, errorResult(`Charter could not complete the call: ${String(body.error ?? res.statusCode)}`));
      }
      return ok(id, verdictToResult(name, body as Parameters<typeof verdictToResult>[1]));
    }

    default:
      if (isNotification(req)) return null;
      return err(id, RPC.METHOD_NOT_FOUND, `${req.method} is not supported by this server`);
  }
}

export { LATEST_PROTOCOL_VERSION };
