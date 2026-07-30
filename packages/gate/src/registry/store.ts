import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { jcsHashToken, sha256Token } from "@mandate/shared";
import type { AuthorityDoc, AuthorityStatus, CharterStatus, MaxAutonomy } from "@mandate/shared";
import type { Pool, PoolClient } from "../db.js";
import { appendEntry } from "../ledger.js";

/**
 * The Registry (Charter §5.1) and Authority documents (§5.2).
 *
 * Registration, every grant, every revocation and every reinstatement is a LEDGER EVENT — the
 * registry is not a config table you can quietly edit, it is an evidenced object. All writes here
 * run inside one transaction with their ledger entry, same discipline as verdicts.
 */

export interface AuthorityRow {
  id: string;
  ref: string;
  version: number;
  grantor_principal: string;
  valid_from: string;
  valid_until: string;
  budget_minor: number | null;
  budget_currency: string;
  budget_window_minutes: number;
  allowed_tools: string[];
  forbidden_ops: string[];
  status: AuthorityStatus;
  doc_hash: string;
  granted_entry_id: string;
  revoked_by: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Everything the gate needs about an agent's standing, with all time comparisons made by Postgres. */
export interface CharterContext {
  agent: {
    id: string;
    name: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    owner_principal: string | null;
    department: string | null;
    approver_chain: string[];
    expires_at: string | null;
    max_autonomy: MaxAutonomy;
  };
  charter_expired: boolean;
  authority: AuthorityRow | null;
  authority_not_yet_valid: boolean;
  authority_expired: boolean;
}

const AUTHORITY_COLUMNS = `au.id, au.ref, au.version, au.grantor_principal,
  to_char(au.valid_from  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from,
  to_char(au.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_until,
  au.budget_minor, au.budget_currency, au.budget_window_minutes,
  au.allowed_tools, au.forbidden_ops, au.status, au.doc_hash, au.granted_entry_id,
  au.revoked_by,
  to_char(au.revoked_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revoked_at,
  to_char(au.created_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

/** `pg` returns bigint columns as strings; budget_minor must be a number for arithmetic. */
function normalizeAuthority(row: AuthorityRow | undefined | null): AuthorityRow | null {
  if (!row || !row.id) return null;
  return {
    ...row,
    version: Number(row.version),
    budget_minor: row.budget_minor === null ? null : Number(row.budget_minor),
    budget_window_minutes: Number(row.budget_window_minutes),
    allowed_tools: row.allowed_tools ?? [],
    forbidden_ops: row.forbidden_ops ?? [],
  };
}

/**
 * Load an agent's charter + its live grant, with expiry decided by `now()` in the database (never
 * the app clock — CLAUDE.md). Returns null when the agent does not exist.
 */
export async function loadCharter(
  client: PoolClient | Pool,
  tenant: string,
  agentId: string,
): Promise<CharterContext | null> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    owner_principal: string | null;
    department: string | null;
    approver_chain: string[];
    expires_at: string | null;
    max_autonomy: MaxAutonomy;
    charter_expired: boolean;
    authority_not_yet_valid: boolean | null;
    authority_expired: boolean | null;
    auth: AuthorityRow | null;
  }>(
    `SELECT a.id, a.name, a.status, a.owner_principal, a.department, a.approver_chain,
            to_char(a.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
            a.max_autonomy,
            (a.expires_at IS NOT NULL AND a.expires_at <= now())      AS charter_expired,
            (au.id IS NOT NULL AND au.valid_from  >  now())           AS authority_not_yet_valid,
            (au.id IS NOT NULL AND au.valid_until <= now())           AS authority_expired,
            CASE WHEN au.id IS NULL THEN NULL ELSE
              json_build_object(
                'id', au.id, 'ref', au.ref, 'version', au.version,
                'grantor_principal', au.grantor_principal,
                'valid_from',  to_char(au.valid_from  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'valid_until', to_char(au.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'budget_minor', au.budget_minor, 'budget_currency', au.budget_currency,
                'budget_window_minutes', au.budget_window_minutes,
                'allowed_tools', au.allowed_tools, 'forbidden_ops', au.forbidden_ops,
                'status', au.status, 'doc_hash', au.doc_hash,
                'granted_entry_id', au.granted_entry_id,
                'revoked_by', au.revoked_by, 'revoked_at', au.revoked_at,
                'created_at', to_char(au.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) END AS auth
       FROM agents a
       LEFT JOIN authorities au
         ON au.tenant_id = a.tenant_id AND au.agent_id = a.id AND au.status = 'ACTIVE'
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenant, agentId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    agent: {
      id: r.id,
      name: r.name,
      status: r.status,
      owner_principal: r.owner_principal,
      department: r.department,
      approver_chain: r.approver_chain ?? [],
      expires_at: r.expires_at,
      max_autonomy: r.max_autonomy,
    },
    charter_expired: r.charter_expired,
    authority: normalizeAuthority(r.auth),
    authority_not_yet_valid: r.authority_not_yet_valid ?? false,
    authority_expired: r.authority_expired ?? false,
  };
}

/** Derived registry status — what an operator sees on the charter card. */
export function charterStatus(ctx: {
  agent: { status: string };
  charter_expired: boolean;
}): CharterStatus {
  if (ctx.agent.status !== "ACTIVE") return ctx.agent.status as CharterStatus;
  return ctx.charter_expired ? "EXPIRED" : "ACTIVE";
}

export interface RegisterAgentInput {
  tenant: string;
  agentId: string;
  name: string;
  ownerPrincipal: string;
  department: string;
  purpose?: string;
  approverChain?: string[];
  expiresAt: string; // ISO 8601
  maxAutonomy?: MaxAutonomy;
  /** Pin the key (seeding/demos). Omit to mint one — returned exactly once. */
  apiKey?: string;
}

export type RegisterResult =
  | { ok: true; apiKey: string; entryId: string }
  | { ok: false; code: number; reason: string };

/** Register (charter) an agent: agents row + AGENT_REGISTERED ledger entry, one transaction. */
export async function registerAgent(
  pool: Pool,
  input: RegisterAgentInput,
): Promise<RegisterResult> {
  const apiKey = input.apiKey ?? `chr_${randomBytes(24).toString("base64url")}`;
  const fingerprint = sha256Token(apiKey);
  const entryId = ulid();

  const owner = await pool.query("SELECT 1 FROM principals WHERE tenant_id = $1 AND id = $2", [
    input.tenant,
    input.ownerPrincipal,
  ]);
  if (owner.rowCount === 0) {
    // Fail closed: no agent may exist without an accountable human who actually exists.
    return { ok: false, code: 400, reason: `owner principal ${input.ownerPrincipal} not found` };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO agents (id, tenant_id, name, key_fingerprint, max_autonomy, status,
                           owner_principal, department, purpose, approver_chain, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10::timestamptz)
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING id`,
      [
        input.agentId,
        input.tenant,
        input.name,
        fingerprint,
        input.maxAutonomy ?? "ALLOW",
        input.ownerPrincipal,
        input.department,
        input.purpose ?? null,
        input.approverChain ?? [],
        input.expiresAt,
      ],
    );
    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: 409, reason: `agent ${input.agentId} already registered` };
    }

    await appendEntry(client, {
      tenant: input.tenant,
      kind: "AGENT_REGISTERED",
      entryId,
      body: {
        agent: {
          id: input.agentId,
          name: input.name,
          key_fingerprint: fingerprint,
          max_autonomy: input.maxAutonomy ?? "ALLOW",
        },
        owner_principal: input.ownerPrincipal,
        department: input.department,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        approver_chain: input.approverChain ?? [],
        expires_at: input.expiresAt,
      },
    });
    await client.query("COMMIT");
    return { ok: true, apiKey, entryId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface GrantAuthorityInput {
  tenant: string;
  agentId: string;
  grantorPrincipal: string;
  validFrom: string;
  validUntil: string;
  budgetMinor: number | null;
  budgetCurrency?: string;
  budgetWindowMinutes?: number;
  allowedTools: string[];
  forbiddenOps: string[];
  /** Human ref like 'auth_2026_0071'. Generated from the version when omitted. */
  ref?: string;
}

export type GrantResult =
  | { ok: true; authorityId: string; ref: string; version: number; docHash: string; entryId: string }
  | { ok: false; code: number; reason: string };

/**
 * Issue a grant. A new grant SUPERSEDES the agent's live one (authority is versioned, never edited)
 * and writes an AUTHORITY_GRANTED entry carrying the full document + its hash, so a later auditor can
 * prove which grant a verdict was decided under.
 */
export async function grantAuthority(pool: Pool, input: GrantAuthorityInput): Promise<GrantResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const agent = await client.query(
      "SELECT 1 FROM agents WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [input.tenant, input.agentId],
    );
    if (agent.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: 404, reason: `agent ${input.agentId} not registered` };
    }
    const grantor = await client.query(
      "SELECT 1 FROM principals WHERE tenant_id = $1 AND id = $2",
      [input.tenant, input.grantorPrincipal],
    );
    if (grantor.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: 400, reason: `grantor ${input.grantorPrincipal} not found` };
    }

    const maxV = await client.query<{ v: number | null }>(
      "SELECT max(version) AS v FROM authorities WHERE tenant_id = $1 AND agent_id = $2",
      [input.tenant, input.agentId],
    );
    const version = (maxV.rows[0]?.v ?? 0) + 1;
    const ref = input.ref ?? `auth_${new Date(input.validFrom).getUTCFullYear()}_${String(version).padStart(4, "0")}`;
    const authorityId = ulid();
    const entryId = ulid();

    const doc: AuthorityDoc = {
      ref,
      tenant: input.tenant,
      agent_id: input.agentId,
      version,
      grantor: input.grantorPrincipal,
      valid_from: input.validFrom,
      valid_until: input.validUntil,
      budget:
        input.budgetMinor === null
          ? null
          : {
              minor: input.budgetMinor,
              currency: input.budgetCurrency ?? "INR",
              window_minutes: input.budgetWindowMinutes ?? 1440,
            },
      allowed_tools: [...input.allowedTools],
      forbidden_ops: [...input.forbiddenOps],
    };
    const docHash = jcsHashToken(doc);

    // Supersede the live grant (status flip only — the grant's substance stays immutable).
    await client.query(
      `UPDATE authorities SET status = 'SUPERSEDED'
        WHERE tenant_id = $1 AND agent_id = $2 AND status = 'ACTIVE'`,
      [input.tenant, input.agentId],
    );

    await client.query(
      `INSERT INTO authorities
         (id, ref, tenant_id, agent_id, version, grantor_principal, valid_from, valid_until,
          budget_minor, budget_currency, budget_window_minutes, allowed_tools, forbidden_ops,
          status, doc, doc_hash, granted_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10,$11,$12,$13,'ACTIVE',$14,$15,$16)`,
      [
        authorityId,
        ref,
        input.tenant,
        input.agentId,
        version,
        input.grantorPrincipal,
        input.validFrom,
        input.validUntil,
        input.budgetMinor,
        input.budgetCurrency ?? "INR",
        input.budgetWindowMinutes ?? 1440,
        input.allowedTools,
        input.forbiddenOps,
        doc,
        docHash,
        entryId,
      ],
    );

    await appendEntry(client, {
      tenant: input.tenant,
      kind: "AUTHORITY_GRANTED",
      entryId,
      body: {
        authority: { id: authorityId, ref, version, doc_hash: docHash },
        agent: { id: input.agentId },
        grantor: input.grantorPrincipal,
        doc,
      },
    });
    await client.query("COMMIT");
    return { ok: true, authorityId, ref, version, docHash, entryId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type RevokeResult =
  | { ok: true; entryId: string; agentId: string }
  | { ok: false; code: number; reason: string };

/** Revoke a live grant. The agent is left with NO authority → the gate denies everything (D17). */
export async function revokeAuthority(
  pool: Pool,
  tenant: string,
  authorityId: string,
  revokedBy: string,
  reason?: string,
): Promise<RevokeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ agent_id: string; ref: string; status: string }>(
      `SELECT agent_id, ref, status FROM authorities
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenant, authorityId],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: 404, reason: "authority not found" };
    }
    if (row.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: 409, reason: `authority is already ${row.status}` };
    }

    const entryId = ulid();
    await client.query(
      `UPDATE authorities
          SET status = 'REVOKED', revoked_by = $3, revoked_at = now(), revoked_entry_id = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenant, authorityId, revokedBy, entryId],
    );
    await appendEntry(client, {
      tenant,
      kind: "AUTHORITY_REVOKED",
      entryId,
      body: {
        authority: { id: authorityId, ref: row.ref },
        agent: { id: row.agent_id },
        revoked_by: revokedBy,
        ...(reason ? { reason } : {}),
      },
    });
    await client.query("COMMIT");
    return { ok: true, entryId, agentId: row.agent_id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type ReinstateResult =
  | { ok: true; entryId: string }
  | { ok: false; code: number; reason: string };

/**
 * Un-suspend an agent (AGENT_REINSTATED entry). D15 left un-suspend out of scope (manual SQL); a
 * kill switch you cannot release makes the demo un-rerunnable, so it exists here as an audited,
 * admin-only action rather than a hand-edited row.
 */
export async function reinstateAgent(
  pool: Pool,
  tenant: string,
  agentId: string,
  by: string,
): Promise<ReinstateResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      "SELECT status FROM agents WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenant, agentId],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: 404, reason: "agent not found" };
    }
    if (row.status === "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: 409, reason: "agent is already ACTIVE" };
    }
    const entryId = ulid();
    await client.query(
      "UPDATE agents SET status = 'ACTIVE' WHERE tenant_id = $1 AND id = $2",
      [tenant, agentId],
    );
    await appendEntry(client, {
      tenant,
      kind: "AGENT_REINSTATED",
      entryId,
      body: { agent: { id: agentId }, from_status: row.status, reinstated_by: by },
    });
    await client.query("COMMIT");
    return { ok: true, entryId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface RegistryCard {
  id: string;
  name: string;
  status: string;
  charter_status: CharterStatus;
  owner_principal: string | null;
  owner_name: string | null;
  department: string | null;
  purpose: string | null;
  approver_chain: string[];
  max_autonomy: MaxAutonomy;
  expires_at: string | null;
  registered_at: string | null;
  days_until_expiry: number | null;
  authority: AuthorityRow | null;
  /** Spend inside the live grant's budget window, minor units. */
  spend_window_minor: number;
  action_count: number;
}

/** Registry listing — the charter cards. One query per agent is fine at POC scale. */
export async function listRegistry(pool: Pool, tenant: string): Promise<RegistryCard[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    status: string;
    owner_principal: string | null;
    owner_name: string | null;
    department: string | null;
    purpose: string | null;
    approver_chain: string[];
    max_autonomy: MaxAutonomy;
    expires_at: string | null;
    registered_at: string | null;
    charter_expired: boolean;
    days_until_expiry: number | null;
    action_count: string;
  }>(
    `SELECT a.id, a.name, a.status, a.owner_principal, p.display_name AS owner_name,
            a.department, a.purpose, a.approver_chain, a.max_autonomy,
            to_char(a.expires_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
            to_char(a.registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at,
            (a.expires_at IS NOT NULL AND a.expires_at <= now()) AS charter_expired,
            CASE WHEN a.expires_at IS NULL THEN NULL
                 ELSE floor(EXTRACT(EPOCH FROM (a.expires_at - now())) / 86400)::int END
              AS days_until_expiry,
            (SELECT count(*) FROM ledger_entries le
              WHERE le.tenant_id = a.tenant_id AND le.kind = 'VERDICT'
                AND le.payload->'agent'->>'id' = a.id) AS action_count
       FROM agents a
       LEFT JOIN principals p ON p.tenant_id = a.tenant_id AND p.id = a.owner_principal
      WHERE a.tenant_id = $1
      ORDER BY a.registered_at ASC, a.id ASC`,
    [tenant],
  );

  const cards: RegistryCard[] = [];
  for (const r of rows) {
    const auth = await pool.query(
      `SELECT ${AUTHORITY_COLUMNS} FROM authorities au
        WHERE au.tenant_id = $1 AND au.agent_id = $2 AND au.status = 'ACTIVE'`,
      [tenant, r.id],
    );
    const authority = normalizeAuthority(auth.rows[0] as AuthorityRow | undefined);
    let spend = 0;
    if (authority) {
      const s = await pool.query<{ s: string }>(
        `SELECT COALESCE(SUM(event_sum), 0)::bigint AS s FROM limit_counters
          WHERE tenant_id = $1 AND rule_id = $2 AND key = $3
            AND window_start > now() - make_interval(mins => $4)`,
        [tenant, `authority:${authority.id}`, `agent:${r.id}`, authority.budget_window_minutes],
      );
      spend = Number(s.rows[0]!.s);
    }
    cards.push({
      id: r.id,
      name: r.name,
      status: r.status,
      charter_status: charterStatus({ agent: { status: r.status }, charter_expired: r.charter_expired }),
      owner_principal: r.owner_principal,
      owner_name: r.owner_name,
      department: r.department,
      purpose: r.purpose,
      approver_chain: r.approver_chain ?? [],
      max_autonomy: r.max_autonomy,
      expires_at: r.expires_at,
      registered_at: r.registered_at,
      days_until_expiry: r.days_until_expiry,
      authority,
      spend_window_minor: spend,
      action_count: Number(r.action_count),
    });
  }
  return cards;
}

/** Full grant history for one agent (newest first) — the authority audit trail. */
export async function listAuthorities(
  pool: Pool,
  tenant: string,
  agentId: string,
): Promise<AuthorityRow[]> {
  const { rows } = await pool.query(
    `SELECT ${AUTHORITY_COLUMNS} FROM authorities au
      WHERE au.tenant_id = $1 AND au.agent_id = $2
      ORDER BY au.version DESC`,
    [tenant, agentId],
  );
  return (rows as AuthorityRow[]).map((r) => normalizeAuthority(r)!).filter(Boolean);
}
