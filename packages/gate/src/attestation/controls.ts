import type { ControlMappingRow } from "./types.js";

/**
 * Control mapping (Charter §5.5).
 *
 * WORDING DISCIPLINE — read this before editing a row. Each row says three things and no more:
 *   1. a control reference, cited at the level of generality we can actually defend;
 *   2. what Charter *evidences* for it — not what it certifies, satisfies, or complies with;
 *   3. where in this pack a reader can go and check for themselves.
 *
 * "Evidence mapped to a control" is the claim. "Certified compliant" is NOT the claim, is not ours
 * to make, and requires an assessor. Do not upgrade the verbs.
 */
export const CONTROL_MAPPING: ControlMappingRow[] = [
  {
    framework: "RBI",
    control_reference:
      "RBI — maker-checker / dual authorisation for financially material actions (IT Governance, Risk, Controls and Assurance Practices Direction, 2023; clause-level mapping not asserted)",
    expectation:
      "A financially material action initiated by one party is authorised by a second, different party, and that second authorisation is recorded.",
    charter_evidence:
      "Every action the policy escalates is held pending a named human principal's decision. The gate refuses a decision from the initiating principal, so the second authoriser is always a different party. Nothing executes on an undecided hold.",
    proof_location: [
      "maker_checker.escalations[].decided_by",
      "maker_checker.escalations[].initiating_principal",
      "maker_checker.summary.self_approvals",
      "maker_checker.summary.no_self_approval",
    ],
  },
  {
    framework: "RBI",
    control_reference:
      "RBI — audit trail / system logs for automated and straight-through processing (IT Governance Direction, 2023; Cyber Security Framework log-retention expectations)",
    expectation:
      "Automated processing keeps a complete, sequential and non-repudiable trail of what was decided and on what basis.",
    charter_evidence:
      "Each authorisation decision is written to an append-only, per-tenant hash-chained ledger inside the same transaction that returns the verdict; no verdict is returned before its entry is committed. Entries carry the agent, principal, tool, parameter hash, policy version and full rule trace.",
    proof_location: [
      "header.entries_covered",
      "header.entries_by_kind",
      "evidence_integrity.chain.prev_hash_linkage_verified",
      "evidence_integrity.chain.first_break_seq",
    ],
  },
  {
    framework: "RBI",
    control_reference:
      "RBI — delegation of financial authority and limit discipline (expectation that automated actors operate inside a documented, time-bound, monetarily capped charter)",
    expectation:
      "An actor that can move money holds a documented authority with a named grantor, an expiry and a monetary ceiling, and cannot exceed it.",
    charter_evidence:
      "Each agent holds a versioned authority document (named grantor, validity window, budget in minor units per window, allowed tools, forbidden operations), hashed into the ledger when granted. The gate denies actions outside the grant even where the operational policy would allow them; exceeding the budget is a denial, not an escalation.",
    proof_location: [
      "registry.agents[].authorities_in_force[]",
      "registry.agents[].charter.expires_at",
      "enforcement.by_rule (rule_id values prefixed authority. / charter.)",
    ],
  },
  {
    framework: "EU AI Act",
    control_reference: "Regulation (EU) 2024/1689, Article 12 — record-keeping / automatic logging",
    expectation:
      "High-risk AI systems technically allow for the automatic recording of events (logs) over the system's lifetime, to a degree appropriate to the intended purpose.",
    charter_evidence:
      "Every decision event is automatically logged without the agent's cooperation being optional at record time — the log write is the precondition of the verdict. Logs are sealed into signed Merkle checkpoints so a later reader can tell whether the record set has been altered or truncated.",
    proof_location: [
      "header.entries_by_kind",
      "evidence_integrity.checkpoints.covering[].merkle_root",
      "evidence_integrity.checkpoints.covering[].signature",
      "evidence_integrity.anchors_log.lines",
    ],
  },
  {
    framework: "EU AI Act",
    control_reference: "Regulation (EU) 2024/1689, Article 14 — human oversight",
    expectation:
      "High-risk AI systems are designed so natural persons can oversee operation, intervene, and interrupt the system.",
    charter_evidence:
      "Two oversight mechanisms are exercised and evidenced: per-action human decision on escalated actions (with a TTL that denies on silence rather than proceeding), and an agent-level kill switch that suspends an agent and is itself a ledger event. Both leave records naming the human involved.",
    proof_location: [
      "maker_checker.escalations[].hold_status",
      "maker_checker.summary.expired_denied_by_timeout",
      "header.entries_by_kind.AGENT_SUSPENDED",
      "registry.agents[].charter.approver_chain",
    ],
  },
  {
    framework: "SOC 2",
    control_reference: "TSC CC7.2 / CC7.3 — monitoring for anomalies, evaluation of security events",
    expectation:
      "The entity monitors system components for anomalous behaviour and evaluates detected events to decide whether they represent a failure of a control objective.",
    charter_evidence:
      "Denials and escalations are first-class monitored signals with rule-level attribution, queryable per tool, per rule and per agent for any period, plus a live event stream of verdicts as they land.",
    proof_location: [
      "enforcement.by_verdict",
      "enforcement.by_tool",
      "enforcement.top_denial_reasons",
      "enforcement.by_rule",
    ],
  },
  {
    framework: "SOC 2",
    control_reference: "TSC CC8.1 — change management for authorisation logic",
    expectation:
      "Changes to infrastructure, data, software and procedures are authorised, documented and tracked.",
    charter_evidence:
      "Policy documents are immutable versioned rows; activating one writes a POLICY_ACTIVATED ledger entry carrying the document hash, so every verdict can be tied to the exact policy text in force. Authority grants are versioned the same way and never edited — a change is a new version with its own hash, and revocation is a ledger event.",
    proof_location: [
      "header.policy.version",
      "header.policy.doc_hash",
      "header.entries_by_kind.POLICY_ACTIVATED",
      "header.entries_by_kind.AUTHORITY_GRANTED",
      "header.entries_by_kind.AUTHORITY_REVOKED",
      "registry.agents[].authorities_in_force[].doc_hash",
    ],
  },
];

export const LIMITATIONS_NOTE =
  "This pack is evidence produced by the Charter gate about its own decisions. It is not an audit " +
  "opinion, a certification, or a statement that any framework above is satisfied — an assessor " +
  "reaches that conclusion, not this document. The following limitations are inherent to the " +
  "proof-of-concept and are stated so that no reader over-reads the evidence.";

export const LIMITATIONS: string[] = [
  "Enforcement is SDK-integration (Pattern A, DECISIONS D1): the gate authorises actions the agent " +
    "asks it about. A code path that calls a tool without going through the SDK is not visible here. " +
    "Coverage of every tool call therefore depends on integration completeness, not on this pack. " +
    "The credential-custody proxy tier that would make bypass impossible is out of POC scope.",
  "Action parameters are stored in the ledger unencrypted (DECISIONS D12); each entry also carries " +
    "params_hash. Field-level encryption and redaction policy are out of POC scope, so this pack " +
    "and the underlying ledger should be handled as containing business data.",
  "Checkpoint anchoring is an append to a local anchors.log file (DECISIONS D5), not WORM storage, " +
    "a timestamping authority, or a third-party notary. It defends against silent in-database " +
    "rewriting, not against an actor who controls both the database and that file.",
  "Trailing entries recorded after the most recent checkpoint are not yet sealed by a Merkle root. " +
    "They remain chained, but their inclusion proof is only as strong as the chain until the next " +
    "checkpoint is written — see evidence_integrity.checkpoints.trailing_uncheckpointed.",
  "Chain and hash verification reported here is performed by the gate itself, using the same " +
    "canonicalisation code that wrote the entries. Independent verification requires the separate " +
    "verifier CLI, which re-implements JCS, hashing, Merkle and signature checking with no shared " +
    "code (DECISIONS D6) and reads with a read-only role.",
  "Period boundaries are applied to entry timestamps generated by Postgres now(). Actions in flight " +
    "at the period edge may fall outside the window even though their effect did not.",
];
