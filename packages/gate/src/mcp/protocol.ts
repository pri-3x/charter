/**
 * JSON-RPC 2.0 shapes and the MCP error codes, kept apart from the gate so the wire format can be
 * reasoned about on its own.
 *
 * MCP is JSON-RPC over a transport. The subset here is the subset a tool server actually needs:
 * initialize, tools/list, tools/call, ping. Resources and prompts are deliberately absent — Charter
 * gates ACTIONS, and a tool call is the only MCP verb that is one.
 */

export const JSONRPC_VERSION = "2.0";

/** Protocol revisions this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC reserved codes. MCP adds no codes of its own; tool failures are results, not errors. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface RpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Absent ⇒ a notification: no response may be sent. */
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcResponse =
  | { jsonrpc: typeof JSONRPC_VERSION; id: string | number | null; result: unknown }
  | { jsonrpc: typeof JSONRPC_VERSION; id: string | number | null; error: RpcError };

export const ok = (id: string | number | null, result: unknown): RpcResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  result,
});

export const err = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** A notification carries no id and must not be answered. */
export function isNotification(req: RpcRequest): boolean {
  return req.id === undefined;
}

export function parseRequest(body: unknown): RpcRequest | RpcError {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { code: RPC.INVALID_REQUEST, message: "expected a JSON-RPC request object" };
  }
  const r = body as Record<string, unknown>;
  if (r.jsonrpc !== JSONRPC_VERSION) {
    return { code: RPC.INVALID_REQUEST, message: `jsonrpc must be "${JSONRPC_VERSION}"` };
  }
  if (typeof r.method !== "string" || r.method === "") {
    return { code: RPC.INVALID_REQUEST, message: "method is required" };
  }
  if ("id" in r && !(typeof r.id === "string" || typeof r.id === "number" || r.id === null)) {
    return { code: RPC.INVALID_REQUEST, message: "id must be a string, a number or null" };
  }
  const out: RpcRequest = { jsonrpc: JSONRPC_VERSION, method: r.method };
  if ("id" in r) out.id = r.id as string | number | null;
  if (r.params !== undefined) {
    if (typeof r.params !== "object" || r.params === null || Array.isArray(r.params)) {
      return { code: RPC.INVALID_PARAMS, message: "params must be an object" };
    }
    out.params = r.params as Record<string, unknown>;
  }
  return out;
}

/** Negotiate a protocol version: the client's if we speak it, otherwise our newest. */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

// ----------------------------------------------------------------------------- tool results ----

/**
 * An MCP tool result. `isError: true` is how a tool reports that the CALL failed in a way the model
 * should read and react to — as opposed to a JSON-RPC error, which means the request itself was
 * malformed. A policy DENY is emphatically the former: the request was well-formed, the answer is
 * no, and the model needs to understand why so it can tell the user or try something else.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** Echoed back for the caller; MCP permits extra fields alongside content. */
  _meta?: Record<string, unknown>;
}

export const textResult = (text: string, meta?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(meta ? { _meta: meta } : {}),
});

export const errorResult = (text: string, meta?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
  ...(meta ? { _meta: meta } : {}),
});
