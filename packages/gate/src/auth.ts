import { sha256Token } from "@charter/shared";
import type { MaxAutonomy, AgentStatus } from "@charter/shared";
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
  /**
   * `tenant` absent  → the global operator key: every tenant, every route.
   * `tenant` present → admin for that tenant ONLY. Deliberately the same `kind`, so the 18 existing
   *   `auth.kind !== "admin"` checks keep working unchanged; the scoping is enforced separately by
   *   pinning the tenant on the request (see requireAdmin), which is safe even for a route that
   *   forgets to look.
   */
  | { kind: "admin"; tenant?: string }
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

  // The global operator key first: a constant-time-ish exact match, no database round trip.
  if (token === adminKey) return { kind: "admin" };

  const fingerprint = sha256Token(token);

  // A tenant-scoped admin key. Checked before agent keys because the two namespaces are disjoint
  // and this ordering keeps the common agent path at one query.
  const scoped = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM tenant_admin_keys WHERE fingerprint = $1 AND status = 'ACTIVE'",
    [fingerprint],
  );
  if (scoped.rows[0]) return { kind: "admin", tenant: scoped.rows[0].tenant_id };
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, tenant_id, name, key_fingerprint, max_autonomy, status
       FROM agents WHERE key_fingerprint = $1`,
    [fingerprint],
  );
  const agent = rows[0];
  if (!agent) return { kind: "none" };
  return { kind: "agent", agent };
}
