import { sha256Token } from "@mandate/shared";
import type { MaxAutonomy, AgentStatus } from "@mandate/shared";
import type { Pool } from "./db.js";

export interface AgentRow {
  id: string;
  tenant_id: string;
  name: string;
  key_fingerprint: string;
  max_autonomy: MaxAutonomy;
  status: AgentStatus;
}

export type AuthResult =
  | { kind: "agent"; agent: AgentRow }
  | { kind: "admin" }
  | { kind: "none" };

/** Extract a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * Resolve an Authorization header to an agent, the admin, or nobody. Agent keys are looked up by
 * SHA-256 fingerprint (we never store the raw key). The admin key is a shared secret from env.
 */
export async function resolveAuth(
  pool: Pool,
  header: string | undefined,
  adminKey: string,
): Promise<AuthResult> {
  const token = bearerToken(header);
  if (!token) return { kind: "none" };

  if (token === adminKey) return { kind: "admin" };

  const fingerprint = sha256Token(token);
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, tenant_id, name, key_fingerprint, max_autonomy, status
       FROM agents WHERE key_fingerprint = $1`,
    [fingerprint],
  );
  const agent = rows[0];
  if (!agent) return { kind: "none" };
  return { kind: "agent", agent };
}
