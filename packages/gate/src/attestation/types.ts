import type {
  AuthorityStatus,
  CharterStatus,
  HoldStatus,
  MaxAutonomy,
  Verdict,
} from "@charter/shared";

/**
 * The regulator-facing evidence pack (Charter §5.5).
 *
 * Everything in here is COMPUTED FROM THE LEDGER. There is no field that is asserted rather than
 * derived, and no field that claims compliance — the control mapping says "this evidence speaks to
 * that expectation", which is a different and honest claim.
 */

export interface AttestationPeriod {
  from: string;
  to: string;
}

export interface AttestationHeader {
  tenant_id: string;
  tenant_name: string | null;
  period: AttestationPeriod;
  /** Postgres now() at generation time. NOT covered by pack_hash (see pack_hash_covers). */
  generated_at: string;
  agent_filter: string | null;
  policy: { version: number | null; doc_hash: string | null; activated_at: string | null };
  /** Ledger entries of every kind in the period, tenant-wide (the chain is per-tenant, D4). */
  entries_covered: number;
  entries_by_kind: Record<string, number>;
  seq_range: { from: number; to: number } | null;
  scope_note: string;
}

export interface AttestationGrant {
  authority_id: string;
  ref: string;
  version: number;
  status: AuthorityStatus;
  grantor_principal: string;
  valid_from: string;
  valid_until: string;
  budget: { minor: number; currency: string; window_minutes: number } | null;
  allowed_tools: string[];
  forbidden_ops: string[];
  doc_hash: string;
  granted_entry_id: string;
  revoked_by: string | null;
  revoked_at: string | null;
}

export interface AttestationAgent {
  id: string;
  name: string | null;
  charter: {
    owner_principal: string | null;
    owner_name: string | null;
    department: string | null;
    purpose: string | null;
    expires_at: string | null;
    charter_status: CharterStatus | "UNKNOWN";
    max_autonomy: MaxAutonomy | null;
    approver_chain: string[];
    registered_at: string | null;
  };
  /** True when the ledger shows this agent acting but no registry row exists for it any more. */
  registry_record_missing: boolean;
  authorities_in_force: AttestationGrant[];
  authorities_outside_period: number;
  period_activity: { total: number; ALLOW: number; DENY: number; ESCALATE: number };
}

export interface AttestationRegistry {
  agents: AttestationAgent[];
  note: string;
}

export interface MoneyTotal {
  currency: string;
  total_minor: number;
  actions: number;
}

export interface AttestationEnforcement {
  by_verdict: Record<Verdict, number>;
  by_tool: Array<{ tool: string; ALLOW: number; DENY: number; ESCALATE: number; total: number }>;
  by_rule: Array<{ rule_id: string; verdict: Verdict; count: number }>;
  money: {
    note: string;
    allowed: MoneyTotal[];
    denied: MoneyTotal[];
    escalated: MoneyTotal[];
  };
  top_denial_reasons: Array<{ rule_id: string; reason: string | null; count: number }>;
}

export interface AttestationEscalation {
  seq: number;
  entry_id: string;
  ts: string;
  agent_id: string | null;
  tool: string | null;
  principal: string | null;
  rule_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  hold_id: string | null;
  /** NO_HOLD means the VERDICT escalated but no hold row exists — a defect, surfaced not hidden. */
  hold_status: HoldStatus | "NO_HOLD";
  approvers: string[];
  initiating_principal: string | null;
  decided_by: string | null;
  decided_at: string | null;
  ttl_at: string | null;
  decision_latency_seconds: number | null;
  approval_entry_id: string | null;
  approval_decision: string | null;
  /** decided_by === initiating_principal. Must be false everywhere (D9). */
  self_approval: boolean;
  /** EXPIRED holds: the action was denied because nobody decided in time (D9 — a control). */
  denied_by_timeout: boolean;
}

export interface AttestationMakerChecker {
  escalations: AttestationEscalation[];
  summary: {
    total: number;
    APPROVED: number;
    REJECTED: number;
    EXPIRED: number;
    PENDING: number;
    NO_HOLD: number;
    resolved: number;
    expired_denied_by_timeout: number;
    self_approvals: number;
    no_self_approval: boolean;
    /** Holds whose ledger APPROVAL decision disagrees with the holds row. Should be 0. */
    ledger_disagreements: number;
    latency_seconds: { min: number; median: number; max: number } | null;
  };
  statements: string[];
}

export interface AttestationCheckpoint {
  id: string;
  seq_from: number;
  seq_to: number;
  merkle_root: string;
  signature: string;
  created_at: string;
  /** Present as a line in anchors.log (the out-of-band record, D5). */
  anchored_in_log: boolean;
}

export interface AttestationIntegrity {
  chain: {
    entries: number;
    seq_from: number | null;
    seq_to: number | null;
    prev_hash_linkage_verified: boolean;
    first_break_seq: number | null;
    /** The period's first entry links to the entry before it (or to genesis at seq 1). */
    links_to_predecessor: boolean | null;
    predecessor_seq: number | null;
    genesis_verified: boolean | null;
    entry_hash_recomputed: boolean;
    entry_hash_mismatch_seq: number | null;
    note: string;
  };
  checkpoints: {
    covering: AttestationCheckpoint[];
    sealed_ranges: Array<{ seq_from: number; seq_to: number; checkpoint_id: string; entries: number }>;
    uncheckpointed_ranges: Array<{ seq_from: number; seq_to: number; entries: number }>;
    /** The trailing run of entries after the last checkpoint — normally non-empty. */
    trailing_uncheckpointed: { seq_from: number; seq_to: number; entries: number } | null;
    entries_sealed: number;
    entries_not_sealed: number;
    note: string;
  };
  anchors_log: {
    path: string;
    present: boolean;
    lines: number;
    checkpoint_ids: string[];
    note: string;
  };
}

export interface ControlMappingRow {
  framework: "RBI" | "EU AI Act" | "SOC 2";
  control_reference: string;
  expectation: string;
  charter_evidence: string;
  /** Dotted paths into this pack that carry the evidence. */
  proof_location: string[];
}

export interface AttestationPack {
  pack_type: "charter.attestation";
  pack_version: 1;
  header: AttestationHeader;
  registry: AttestationRegistry;
  enforcement: AttestationEnforcement;
  maker_checker: AttestationMakerChecker;
  evidence_integrity: AttestationIntegrity;
  control_mapping: ControlMappingRow[];
  limitations: { note: string; items: string[] };
  pack_hash_covers: string;
  pack_hash: string;
}

export interface BuildAttestationOptions {
  tenant: string;
  /** ISO 8601. Omitted → resolved by Postgres as now() - 30 days. */
  from?: string;
  /** ISO 8601. Omitted → resolved by Postgres as now(). */
  to?: string;
  agentId?: string;
  anchorsLogPath?: string;
}
