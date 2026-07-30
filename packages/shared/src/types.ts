/** Shared domain types for the ledger. Kept dependency-free so gate + sdk can both import them. */

export type Verdict = "ALLOW" | "DENY" | "ESCALATE";

export type EntryKind =
  | "VERDICT"
  | "APPROVAL"
  | "OUTCOME"
  | "POLICY_ACTIVATED"
  | "AGENT_SUSPENDED"
  | "AGENT_REGISTERED"
  | "AGENT_REINSTATED"
  | "AUTHORITY_GRANTED"
  | "AUTHORITY_REVOKED";

export type MaxAutonomy = "ALLOW" | "ESCALATE";
export type AgentStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";
/** What the registry SHOWS. EXPIRED is derived from expires_at, never stored (see schema.sql). */
export type CharterStatus = AgentStatus | "EXPIRED";
export type AuthorityStatus = "ACTIVE" | "REVOKED" | "SUPERSEDED";
export type HoldStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

/**
 * The authority grant document (Charter §5.2) — the thing that gets hashed into the ledger. Field
 * order here is irrelevant (JCS sorts keys); what matters is that every field a verdict depends on
 * is inside the hashed document, so "the agent acted inside its authority" is provable later.
 */
export interface AuthorityDoc {
  ref: string;
  tenant: string;
  agent_id: string;
  version: number;
  grantor: string;
  valid_from: string;
  valid_until: string;
  budget: { minor: number; currency: string; window_minutes: number } | null;
  allowed_tools: string[];
  forbidden_ops: string[];
}

/** Why the authority layer tightened (or didn't) — recorded in every VERDICT payload. */
export interface AuthorityTrace {
  authority_id: string | null;
  ref: string | null;
  version: number | null;
  doc_hash: string | null;
  checks: Array<{ check: string; ok: boolean; why: string }>;
  /** Spend inside the grant's budget window, in minor units, BEFORE this action. */
  spend_before?: number;
  budget_minor?: number | null;
}

/** One entry in a rule_trace: every rule considered during evaluation (SPEC 3.3). */
export interface RuleTraceItem {
  rule_id: string;
  matched: boolean;
  why: string;
}

export interface RuleTrace {
  scope_ok: boolean;
  cap_applied: boolean;
  rules: RuleTraceItem[];
}

/** The chain fields every ledger entry payload carries (SPEC 4.2). */
export interface ChainFields {
  seq: number;
  entry_id: string;
  ts: string;
  tenant: string;
  kind: EntryKind;
  prev_hash: string;
  entry_hash: string;
}

/** A VERDICT entry payload (SPEC 4.1). Other kinds add their own fields on top of ChainFields. */
export interface VerdictPayload extends ChainFields {
  kind: "VERDICT";
  agent: { id: string; key_fingerprint: string };
  principal: string;
  action: {
    tool: string;
    params: Record<string, unknown>;
    params_hash: string;
  };
  context?: { reasoning?: string; conversation_ref?: string };
  policy: { version: number | string; doc_hash: string | null };
  /** The grant this action was checked against (Charter §5.2). Absent only on pre-registry entries. */
  authority?: AuthorityTrace;
  rule_trace: RuleTrace;
  verdict: Verdict;
  rule_id?: string;
  reason?: string;
  hold?: { id: string; approvers: string[]; ttl_minutes: number };
}

export interface OutcomePayload extends ChainFields {
  kind: "OUTCOME";
  verdict_entry_id: string;
  status: "SUCCESS" | "FAILURE";
  result_hash: string;
}
