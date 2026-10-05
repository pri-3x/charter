import { ulid } from "ulid";
import type { Pool, PoolClient } from "../db.js";
import { appendEntry } from "../ledger.js";
import { seal, open as openSecret } from "./crypto.js";
import type { EgressBinding } from "./crypto.js";

/**
 * Storage for Pattern B tool credentials.
 *
 * Registration and revocation are ledger events, so "when did Charter start holding the payment key,
 * and who installed it?" is answerable from the same chain as every verdict. What goes in the ledger
 * is the fingerprint and the egress descriptor — never the secret. An audit trail that leaks the
 * thing it is auditing would be worse than none.
 */

export type AuthScheme = "bearer" | "header" | "basic";
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ToolDescriptor {
  /** Human name, description and JSON Schema — what a MODEL needs to call the tool correctly. */
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

export interface CredentialDescriptor extends ToolDescriptor {
  tenant: string;
  tool: string;
  endpointUrl: string;
  method: Method;
  authScheme: AuthScheme;
  authHeader?: string | undefined;
  fingerprint: string;
  status: "ACTIVE" | "REVOKED";
}

/** A descriptor plus the decrypted secret. Never returned from a route; never logged. */
export interface LiveCredential extends CredentialDescriptor {
  secret: string;
}

interface Row {
  tenant_id: string;
  tool: string;
  endpoint_url: string;
  method: Method;
  auth_scheme: AuthScheme;
  auth_header: string | null;
  secret_ct: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  secret_fp: string;
  status: "ACTIVE" | "REVOKED";
  title: string | null;
  description: string | null;
  input_schema: Record<string, unknown> | null;
}

export class CredentialNotFoundError extends Error {
  constructor(tool: string) {
    super(`no active credential registered for tool '${tool}'`);
    this.name = "CredentialNotFoundError";
  }
}

/**
 * Register (or rotate) the credential for a tool.
 *
 * Rotation is an upsert rather than a second row: there is exactly one active credential per
 * (tenant, tool), so "which key signed this call?" can never be ambiguous. The previous fingerprint
 * is carried into the ledger entry so a rotation is visible as a rotation.
 */
export async function registerCredential(
  pool: Pool,
  key: Buffer,
  input: {
    tenant: string;
    tool: string;
    endpointUrl: string;
    method: Method;
    authScheme: AuthScheme;
    authHeader?: string | undefined;
    secret: string;
    byPrincipal: string;
  } & ToolDescriptor,
): Promise<{ entryId: string; fingerprint: string; rotated: boolean }> {
  // Bind the secret to exactly this destination (see crypto.ts): if the URL is later edited in the
  // database, the credential stops decrypting instead of being delivered somewhere new.
  const binding: EgressBinding = {
    tenant: input.tenant,
    tool: input.tool,
    endpointUrl: input.endpointUrl,
    method: input.method,
    authScheme: input.authScheme,
    authHeader: input.authHeader,
  };
  const sealed = seal(key, input.secret, binding);
  const entryId = ulid();

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    const prev = await client.query<{ secret_fp: string }>(
      "SELECT secret_fp FROM tool_credentials WHERE tenant_id = $1 AND tool = $2 FOR UPDATE",
      [input.tenant, input.tool],
    );
    const rotated = (prev.rowCount ?? 0) > 0;

    await client.query(
      `INSERT INTO tool_credentials
         (tenant_id, tool, endpoint_url, method, auth_scheme, auth_header,
          secret_ct, secret_iv, secret_tag, secret_fp, status, revoked_at, registered_entry_id,
          title, description, input_schema)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',NULL,$11,$12,$13,$14)
       ON CONFLICT (tenant_id, tool) DO UPDATE SET
         endpoint_url = EXCLUDED.endpoint_url,
         method       = EXCLUDED.method,
         auth_scheme  = EXCLUDED.auth_scheme,
         auth_header  = EXCLUDED.auth_header,
         secret_ct    = EXCLUDED.secret_ct,
         secret_iv    = EXCLUDED.secret_iv,
         secret_tag   = EXCLUDED.secret_tag,
         secret_fp    = EXCLUDED.secret_fp,
         status       = 'ACTIVE',
         revoked_at   = NULL,
         registered_entry_id = EXCLUDED.registered_entry_id,
         -- Descriptors are only overwritten when supplied, so rotating a secret does not silently
         -- un-advertise a tool over MCP.
         title        = COALESCE(EXCLUDED.title, tool_credentials.title),
         description  = COALESCE(EXCLUDED.description, tool_credentials.description),
         input_schema = COALESCE(EXCLUDED.input_schema, tool_credentials.input_schema)`,
      [
        input.tenant, input.tool, input.endpointUrl, input.method, input.authScheme,
        input.authHeader ?? null, sealed.ct, sealed.iv, sealed.tag, sealed.fingerprint, entryId,
        input.title ?? null, input.description ?? null,
        input.inputSchema ? JSON.stringify(input.inputSchema) : null,
      ],
    );

    await appendEntry(client, {
      tenant: input.tenant,
      kind: "CREDENTIAL_REGISTERED",
      entryId,
      body: {
        tool: input.tool,
        by_principal: input.byPrincipal,
        // The descriptor is evidence: it is exactly where the gate will send the credential.
        egress: {
          endpoint_url: input.endpointUrl,
          method: input.method,
          auth_scheme: input.authScheme,
          ...(input.authHeader ? { auth_header: input.authHeader } : {}),
        },
        key_fingerprint: sealed.fingerprint,
        ...(rotated ? { rotated_from: prev.rows[0]!.secret_fp } : {}),
      },
    });

    await client.query("COMMIT");
    return { entryId, fingerprint: sealed.fingerprint, rotated };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeCredential(
  pool: Pool,
  input: { tenant: string; tool: string; byPrincipal: string },
): Promise<{ entryId: string } | null> {
  const entryId = ulid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ secret_fp: string }>(
      `UPDATE tool_credentials SET status = 'REVOKED', revoked_at = now()
        WHERE tenant_id = $1 AND tool = $2 AND status = 'ACTIVE'
        RETURNING secret_fp`,
      [input.tenant, input.tool],
    );
    if (row.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await appendEntry(client, {
      tenant: input.tenant,
      kind: "CREDENTIAL_REVOKED",
      entryId,
      body: {
        tool: input.tool,
        by_principal: input.byPrincipal,
        key_fingerprint: row.rows[0]!.secret_fp,
      },
    });
    await client.query("COMMIT");
    return { entryId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Descriptors only — no secrets, no ciphertext. This is what an admin list endpoint may return. */
export async function listCredentials(pool: Pool, tenant: string): Promise<CredentialDescriptor[]> {
  const res = await pool.query<Row>(
    `SELECT tenant_id, tool, endpoint_url, method, auth_scheme, auth_header, secret_fp, status,
            title, description, input_schema
       FROM tool_credentials WHERE tenant_id = $1 ORDER BY tool`,
    [tenant],
  );
  return res.rows.map((r) => ({
    tenant: r.tenant_id,
    tool: r.tool,
    endpointUrl: r.endpoint_url,
    method: r.method,
    authScheme: r.auth_scheme,
    authHeader: r.auth_header ?? undefined,
    fingerprint: r.secret_fp,
    status: r.status,
    title: r.title ?? undefined,
    description: r.description ?? undefined,
    inputSchema: r.input_schema ?? undefined,
  }));
}

/**
 * Decrypt the credential for one tool. Only the egress path calls this, and the plaintext must not
 * outlive the outbound request — it is never returned to a caller and never written anywhere.
 * A REVOKED row is not found: revocation has to bite immediately, not at the next cache expiry.
 */
export async function loadCredential(
  pool: Pool,
  key: Buffer,
  tenant: string,
  tool: string,
): Promise<LiveCredential> {
  const res = await pool.query<Row>(
    `SELECT tenant_id, tool, endpoint_url, method, auth_scheme, auth_header,
            secret_ct, secret_iv, secret_tag, secret_fp, status
       FROM tool_credentials
      WHERE tenant_id = $1 AND tool = $2 AND status = 'ACTIVE'`,
    [tenant, tool],
  );
  if (res.rowCount === 0) throw new CredentialNotFoundError(tool);
  const r = res.rows[0]!;
  return {
    tenant: r.tenant_id,
    tool: r.tool,
    endpointUrl: r.endpoint_url,
    method: r.method,
    authScheme: r.auth_scheme,
    authHeader: r.auth_header ?? undefined,
    fingerprint: r.secret_fp,
    status: r.status,
    // Decrypts only if the stored descriptor still matches the one the secret was sealed against.
    secret: openSecret(
      key,
      { ct: r.secret_ct, iv: r.secret_iv, tag: r.secret_tag },
      {
        tenant: r.tenant_id,
        tool: r.tool,
        endpointUrl: r.endpoint_url,
        method: r.method,
        authScheme: r.auth_scheme,
        authHeader: r.auth_header ?? undefined,
      },
    ),
  };
}
