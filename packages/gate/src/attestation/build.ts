import { existsSync, readFileSync } from "node:fs";
import { computeEntryHash, genesisPrevHash, jcsHashToken } from "@mandate/shared";
import type { Verdict } from "@mandate/shared";
import type { Pool } from "../db.js";
import { listAuthorities, listRegistry } from "../registry/store.js";
import type { AuthorityRow, RegistryCard } from "../registry/store.js";
import { CONTROL_MAPPING, LIMITATIONS, LIMITATIONS_NOTE } from "./controls.js";
import { countInRange, intersect, latencyStats, uncoveredRanges } from "./coverage.js";
import type { SeqRange } from "./coverage.js";
import type {
  AttestationAgent,
  AttestationCheckpoint,
  AttestationEnforcement,
  AttestationEscalation,
  AttestationGrant,
  AttestationIntegrity,
  AttestationMakerChecker,
  AttestationPack,
  BuildAttestationOptions,
  MoneyTotal,
} from "./types.js";

/**
 * Build the evidence pack (Charter §5.5) from the ledger. Read-only: this module never writes.
 *
 * Two rules govern every value below:
 *   - it is derived from a row that exists, or it is null/absent — nothing is inferred or estimated;
 *   - where the evidence is incomplete (unsealed tail, missing hold, absent anchors file) the pack
 *     says so in a field of its own rather than omitting the subject.
 */

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const tsCol = (expr: string): string => `to_char(${expr} AT TIME ZONE 'UTC', ${UTC_ISO})`;

/** Above this many entries in the period the pack reports linkage only and skips rehashing. */
const MAX_REHASH_ENTRIES = 20_000;

const DEFAULT_PERIOD_DAYS = 30;

const ZERO_VERDICTS = (): Record<Verdict, number> => ({ ALLOW: 0, DENY: 0, ESCALATE: 0 });

export class TenantNotFoundError extends Error {
  constructor(tenant: string) {
    super(`tenant ${tenant} not found`);
  }
}

interface Window {
  from: string;
  to: string;
  generated_at: string;
}

/**
 * Resolve the reporting window and the generation timestamp. All three come from Postgres, never the
 * app clock (CLAUDE.md), so a pack's period and its stamp are on the database's timeline.
 */
async function resolveWindow(pool: Pool, opts: BuildAttestationOptions): Promise<Window> {
  const { rows } = await pool.query<{ from: string; to: string; generated_at: string }>(
    `SELECT ${tsCol(`COALESCE($1::timestamptz, now() - make_interval(days => $3::int))`)} AS from,
            ${tsCol(`COALESCE($2::timestamptz, now())`)}                                  AS to,
            ${tsCol("now()")}                                                             AS generated_at`,
    [opts.from ?? null, opts.to ?? null, DEFAULT_PERIOD_DAYS],
  );
  return rows[0]!;
}

/** WHERE fragment shared by every period-scoped query. $1 tenant, $2 from, $3 to. */
const PERIOD = "tenant_id = $1 AND ts >= $2::timestamptz AND ts <= $3::timestamptz";

/** VERDICT-only scope, optionally narrowed to one agent ($4). */
function verdictScope(agentId: string | undefined): string {
  return `${PERIOD} AND kind = 'VERDICT'${
    agentId ? " AND payload->'agent'->>'id' = $4" : ""
  }`;
}

function verdictArgs(t: string, f: string, to: string, agentId?: string): unknown[] {
  return agentId ? [t, f, to, agentId] : [t, f, to];
}

// ---------------------------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------------------------

async function readHeaderFacts(
  pool: Pool,
  tenant: string,
  w: Window,
): Promise<{
  tenantName: string;
  policy: { version: number | null; doc_hash: string | null; activated_at: string | null };
  entriesByKind: Record<string, number>;
  entriesCovered: number;
}> {
  const t = await pool.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [tenant]);
  if (t.rowCount === 0) throw new TenantNotFoundError(tenant);

  const p = await pool.query<{ version: number; doc_hash: string; activated_at: string | null }>(
    `SELECT version, doc_hash, ${tsCol("activated_at")} AS activated_at
       FROM policies WHERE tenant_id = $1 AND status = 'active'`,
    [tenant],
  );
  const policyRow = p.rows[0];

  const k = await pool.query<{ kind: string; c: number }>(
    `SELECT kind, count(*)::int AS c FROM ledger_entries WHERE ${PERIOD} GROUP BY kind ORDER BY kind`,
    [tenant, w.from, w.to],
  );
  const entriesByKind: Record<string, number> = {};
  let entriesCovered = 0;
  for (const row of k.rows) {
    entriesByKind[row.kind] = row.c;
    entriesCovered += row.c;
  }

  return {
    tenantName: t.rows[0]!.name,
    policy: policyRow
      ? {
          version: Number(policyRow.version),
          doc_hash: policyRow.doc_hash,
          activated_at: policyRow.activated_at,
        }
      : { version: null, doc_hash: null, activated_at: null },
    entriesByKind,
    entriesCovered,
  };
}

// ---------------------------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------------------------

function toGrant(a: AuthorityRow): AttestationGrant {
  return {
    authority_id: a.id,
    ref: a.ref,
    version: a.version,
    status: a.status,
    grantor_principal: a.grantor_principal,
    valid_from: a.valid_from,
    valid_until: a.valid_until,
    budget:
      a.budget_minor === null
        ? null
        : {
            minor: a.budget_minor,
            currency: a.budget_currency,
            window_minutes: a.budget_window_minutes,
          },
    allowed_tools: a.allowed_tools,
    forbidden_ops: a.forbidden_ops,
    doc_hash: a.doc_hash,
    granted_entry_id: a.granted_entry_id,
    revoked_by: a.revoked_by,
    revoked_at: a.revoked_at,
  };
}

/**
 * A grant counts as "in force during the period" when its validity window overlaps the period and it
 * had already been issued by the end of it. A grant revoked before the period started is excluded —
 * it could not have authorised anything inside the window.
 */
function inForce(a: AuthorityRow, w: Window): boolean {
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  if (Date.parse(a.created_at) > to) return false;
  if (a.revoked_at !== null && Date.parse(a.revoked_at) < from) return false;
  return Date.parse(a.valid_from) <= to && Date.parse(a.valid_until) >= from;
}

function charterOf(card: RegistryCard | undefined): AttestationAgent["charter"] {
  return {
    owner_principal: card?.owner_principal ?? null,
    owner_name: card?.owner_name ?? null,
    department: card?.department ?? null,
    purpose: card?.purpose ?? null,
    expires_at: card?.expires_at ?? null,
    charter_status: card?.charter_status ?? "UNKNOWN",
    max_autonomy: card?.max_autonomy ?? null,
    approver_chain: card?.approver_chain ?? [],
    registered_at: card?.registered_at ?? null,
  };
}

async function buildRegistry(
  pool: Pool,
  tenant: string,
  w: Window,
  agentId: string | undefined,
): Promise<{ agents: AttestationAgent[]; activity: Map<string, Record<Verdict, number>> }> {
  const acted = await pool.query<{ agent_id: string | null; verdict: Verdict | null; c: number }>(
    `SELECT payload->'agent'->>'id' AS agent_id, payload->>'verdict' AS verdict, count(*)::int AS c
       FROM ledger_entries WHERE ${verdictScope(agentId)}
      GROUP BY 1, 2`,
    verdictArgs(tenant, w.from, w.to, agentId),
  );

  const activity = new Map<string, Record<Verdict, number>>();
  for (const row of acted.rows) {
    const id = row.agent_id ?? "(unattributed)";
    const bucket = activity.get(id) ?? ZERO_VERDICTS();
    if (row.verdict === "ALLOW" || row.verdict === "DENY" || row.verdict === "ESCALATE") {
      bucket[row.verdict] += row.c;
    }
    activity.set(id, bucket);
  }

  const cards = await listRegistry(pool, tenant);
  const byId = new Map(cards.map((c) => [c.id, c]));

  const agents: AttestationAgent[] = [];
  for (const id of [...activity.keys()].sort()) {
    const card = byId.get(id);
    const all = card ? await listAuthorities(pool, tenant, id) : [];
    const forceful = all.filter((a) => inForce(a, w));
    const counts = activity.get(id)!;
    agents.push({
      id,
      name: card?.name ?? null,
      charter: charterOf(card),
      registry_record_missing: card === undefined,
      authorities_in_force: forceful.map(toGrant),
      authorities_outside_period: all.length - forceful.length,
      period_activity: {
        total: counts.ALLOW + counts.DENY + counts.ESCALATE,
        ...counts,
      },
    });
  }
  return { agents, activity };
}

// ---------------------------------------------------------------------------------------------
// enforcement
// ---------------------------------------------------------------------------------------------

async function buildEnforcement(
  pool: Pool,
  tenant: string,
  w: Window,
  agentId: string | undefined,
): Promise<AttestationEnforcement> {
  const scope = verdictScope(agentId);
  const args = verdictArgs(tenant, w.from, w.to, agentId);

  const byVerdict = ZERO_VERDICTS();
  const v = await pool.query<{ verdict: Verdict | null; c: number }>(
    `SELECT payload->>'verdict' AS verdict, count(*)::int AS c
       FROM ledger_entries WHERE ${scope} GROUP BY 1`,
    args,
  );
  for (const row of v.rows) {
    if (row.verdict === "ALLOW" || row.verdict === "DENY" || row.verdict === "ESCALATE") {
      byVerdict[row.verdict] = row.c;
    }
  }

  const tools = await pool.query<{ tool: string | null; verdict: Verdict | null; c: number }>(
    `SELECT payload->'action'->>'tool' AS tool, payload->>'verdict' AS verdict, count(*)::int AS c
       FROM ledger_entries WHERE ${scope} GROUP BY 1, 2`,
    args,
  );
  const toolMap = new Map<string, { ALLOW: number; DENY: number; ESCALATE: number }>();
  for (const row of tools.rows) {
    const tool = row.tool ?? "(none)";
    const bucket = toolMap.get(tool) ?? { ALLOW: 0, DENY: 0, ESCALATE: 0 };
    if (row.verdict === "ALLOW" || row.verdict === "DENY" || row.verdict === "ESCALATE") {
      bucket[row.verdict] += row.c;
    }
    toolMap.set(tool, bucket);
  }
  const byTool = [...toolMap.entries()]
    .map(([tool, b]) => ({ tool, ...b, total: b.ALLOW + b.DENY + b.ESCALATE }))
    .sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool));

  const rules = await pool.query<{ rule_id: string | null; verdict: Verdict | null; c: number }>(
    `SELECT payload->>'rule_id' AS rule_id, payload->>'verdict' AS verdict, count(*)::int AS c
       FROM ledger_entries WHERE ${scope} GROUP BY 1, 2 ORDER BY 3 DESC, 1 ASC`,
    args,
  );
  const byRule = rules.rows
    .filter((r): r is { rule_id: string; verdict: Verdict; c: number } => r.rule_id !== null && r.verdict !== null)
    .map((r) => ({ rule_id: r.rule_id, verdict: r.verdict, count: r.c }));

  // Money: only entries whose amount is an integer participate — floats are a schema violation
  // (D13) and are excluded rather than rounded into a total an auditor would then rely on.
  const money = await pool.query<{
    verdict: Verdict | null;
    currency: string;
    actions: number;
    total_minor: string;
  }>(
    `SELECT payload->>'verdict' AS verdict,
            COALESCE(payload->'action'->'params'->>'currency', '(unspecified)') AS currency,
            count(*)::int AS actions,
            SUM((payload->'action'->'params'->>'amount')::bigint)::text AS total_minor
       FROM ledger_entries
      WHERE ${scope} AND payload->'action'->'params'->>'amount' ~ '^-?[0-9]+$'
      GROUP BY 1, 2 ORDER BY 2`,
    args,
  );
  const bucketFor = (verdict: Verdict): MoneyTotal[] =>
    money.rows
      .filter((r) => r.verdict === verdict)
      .map((r) => ({
        currency: r.currency,
        total_minor: Number(r.total_minor),
        actions: r.actions,
      }));

  const denials = await pool.query<{ rule_id: string | null; reason: string | null; c: number }>(
    `SELECT payload->>'rule_id' AS rule_id, payload->>'reason' AS reason, count(*)::int AS c
       FROM ledger_entries WHERE ${scope} AND payload->>'verdict' = 'DENY'
      GROUP BY 1, 2 ORDER BY 3 DESC, 1 ASC LIMIT 10`,
    args,
  );

  return {
    by_verdict: byVerdict,
    by_tool: byTool,
    by_rule: byRule,
    money: {
      note:
        "Integer minor units (paise for INR), per currency, from the recorded action parameters " +
        "(D13). Entries whose amount is not an integer, and tools that carry no amount, are " +
        "excluded from these totals. ALLOWED means the gate permitted the action; the executed " +
        "outcome is recorded separately as OUTCOME entries.",
      allowed: bucketFor("ALLOW"),
      denied: bucketFor("DENY"),
      escalated: bucketFor("ESCALATE"),
    },
    top_denial_reasons: denials.rows.map((r) => ({
      rule_id: r.rule_id ?? "(none)",
      reason: r.reason,
      count: r.c,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// maker-checker
// ---------------------------------------------------------------------------------------------

interface EscalationRow {
  seq: string;
  entry_id: string;
  ts: string;
  agent_id: string | null;
  tool: string | null;
  principal: string | null;
  rule_id: string | null;
  amount: string | null;
  currency: string | null;
  approvers: string[] | null;
  hold_id: string | null;
  hold_status: string | null;
  initiating_principal: string | null;
  decided_by: string | null;
  decided_at: string | null;
  ttl_at: string | null;
  latency_seconds: string | null;
  approval_entry_id: string | null;
  approval_decision: string | null;
}

async function buildMakerChecker(
  pool: Pool,
  tenant: string,
  w: Window,
  agentId: string | undefined,
): Promise<AttestationMakerChecker> {
  const { rows } = await pool.query<EscalationRow>(
    `SELECT le.seq, le.entry_id, ${tsCol("le.ts")} AS ts,
            le.payload->'agent'->>'id'                    AS agent_id,
            le.payload->'action'->>'tool'                 AS tool,
            le.payload->>'principal'                      AS principal,
            le.payload->>'rule_id'                        AS rule_id,
            le.payload->'action'->'params'->>'amount'     AS amount,
            le.payload->'action'->'params'->>'currency'   AS currency,
            le.payload->'hold'->>'id'                     AS hold_id,
            h.status                                      AS hold_status,
            h.initiating_principal, h.decided_by,
            ${tsCol("h.decided_at")}                      AS decided_at,
            ${tsCol("h.ttl_at")}                          AS ttl_at,
            EXTRACT(EPOCH FROM (h.decided_at - h.created_at))::text AS latency_seconds,
            ap.entry_id                                   AS approval_entry_id,
            ap.payload->>'decision'                       AS approval_decision,
            COALESCE(h.approvers_snapshot, le.payload->'hold'->'approvers') AS approvers
       FROM ledger_entries le
       LEFT JOIN holds h
         ON h.tenant_id = le.tenant_id AND h.id = le.payload->'hold'->>'id'
       LEFT JOIN ledger_entries ap
         ON ap.tenant_id = le.tenant_id AND ap.kind = 'APPROVAL'
            AND ap.payload->>'hold_id' = le.payload->'hold'->>'id'
      WHERE le.tenant_id = $1 AND le.ts >= $2::timestamptz AND le.ts <= $3::timestamptz
        AND le.kind = 'VERDICT' AND le.payload->>'verdict' = 'ESCALATE'
        ${agentId ? "AND le.payload->'agent'->>'id' = $4" : ""}
      ORDER BY le.seq ASC`,
    verdictArgs(tenant, w.from, w.to, agentId),
  );

  const escalations: AttestationEscalation[] = rows.map((r) => {
    const status = (r.hold_status ?? "NO_HOLD") as AttestationEscalation["hold_status"];
    const selfApproval = r.decided_by !== null && r.decided_by === r.initiating_principal;
    return {
      seq: Number(r.seq),
      entry_id: r.entry_id,
      ts: r.ts,
      agent_id: r.agent_id,
      tool: r.tool,
      principal: r.principal,
      rule_id: r.rule_id,
      amount_minor: r.amount !== null && /^-?\d+$/.test(r.amount) ? Number(r.amount) : null,
      currency: r.currency,
      hold_id: r.hold_id,
      hold_status: status,
      approvers: r.approvers ?? [],
      initiating_principal: r.initiating_principal,
      decided_by: r.decided_by,
      decided_at: r.decided_at,
      ttl_at: r.ttl_at,
      decision_latency_seconds:
        r.latency_seconds === null ? null : Math.round(Number(r.latency_seconds) * 1000) / 1000,
      approval_entry_id: r.approval_entry_id,
      approval_decision: r.approval_decision,
      self_approval: selfApproval,
      denied_by_timeout: status === "EXPIRED",
    };
  });

  const count = (s: AttestationEscalation["hold_status"]): number =>
    escalations.filter((e) => e.hold_status === s).length;
  const resolved = escalations.filter(
    (e) => e.hold_status === "APPROVED" || e.hold_status === "REJECTED" || e.hold_status === "EXPIRED",
  );
  const selfApprovals = escalations.filter((e) => e.self_approval).length;
  const disagreements = escalations.filter(
    (e) => e.approval_decision !== null && e.approval_decision !== e.hold_status,
  ).length;
  const expired = count("EXPIRED");

  const statements = [
    `Every one of the ${escalations.length} escalated action(s) in this period was held pending a human decision; ` +
      "none executed on the strength of the agent's own judgement.",
    selfApprovals === 0
      ? `No self-approval occurred: for all ${resolved.length} resolved hold(s) the deciding principal differs from the ` +
        "principal who initiated the action. The gate refuses a same-principal decision at the API boundary (D9), so " +
        "the absence here is enforced, not merely observed."
      : `WARNING: ${selfApprovals} resolved hold(s) record a deciding principal equal to the initiating principal. ` +
        "This should be impossible and must be investigated.",
    expired > 0
      ? `${expired} hold(s) reached their time-to-live without a decision and were resolved as EXPIRED, which DENIES the ` +
        "action. A timeout that denies is the intended control (D9): silence is not consent, and the agent could not " +
        "proceed by waiting."
      : "No hold expired unresolved in this period. Expiry, when it occurs, resolves as a denial (D9) rather than " +
        "letting the action proceed.",
  ];
  if (count("PENDING") > 0) {
    statements.push(
      `${count("PENDING")} hold(s) were still PENDING when this pack was generated. A pending hold has authorised ` +
        "nothing — the action does not proceed until it is decided or expires.",
    );
  }
  if (count("NO_HOLD") > 0) {
    statements.push(
      `${count("NO_HOLD")} escalated verdict(s) have no matching hold row. This is a defect, not a permitted state, ` +
        "and is surfaced here rather than dropped from the count.",
    );
  }

  return {
    escalations,
    summary: {
      total: escalations.length,
      APPROVED: count("APPROVED"),
      REJECTED: count("REJECTED"),
      EXPIRED: expired,
      PENDING: count("PENDING"),
      NO_HOLD: count("NO_HOLD"),
      resolved: resolved.length,
      expired_denied_by_timeout: expired,
      self_approvals: selfApprovals,
      no_self_approval: selfApprovals === 0,
      ledger_disagreements: disagreements,
      latency_seconds: latencyStats(
        escalations
          .map((e) => e.decision_latency_seconds)
          .filter((n): n is number => n !== null),
      ),
    },
    statements,
  };
}

// ---------------------------------------------------------------------------------------------
// evidence integrity
// ---------------------------------------------------------------------------------------------

interface ChainRow {
  seq: string;
  prev_hash: string;
  entry_hash: string;
  payload?: Record<string, unknown>;
}

function readAnchorIds(path: string): { present: boolean; lines: number; ids: string[] } {
  if (!existsSync(path)) return { present: false, lines: 0, ids: [] };
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const ids: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "string") ids.push(parsed.id);
    } catch {
      // A malformed line is still a line; it just yields no id. Counted, not hidden.
    }
  }
  return { present: true, lines: lines.length, ids };
}

async function buildIntegrity(
  pool: Pool,
  tenant: string,
  w: Window,
  entriesCovered: number,
  anchorsLogPath: string,
): Promise<AttestationIntegrity> {
  const rehash = entriesCovered > 0 && entriesCovered <= MAX_REHASH_ENTRIES;
  const chainRows = await pool.query<ChainRow>(
    `SELECT seq, prev_hash, entry_hash${rehash ? ", payload" : ""}
       FROM ledger_entries WHERE ${PERIOD} ORDER BY seq ASC`,
    [tenant, w.from, w.to],
  );
  const rows = chainRows.rows;
  const seqs = rows.map((r) => Number(r.seq));
  const seqFrom = seqs[0] ?? null;
  const seqTo = seqs[seqs.length - 1] ?? null;

  let firstBreak: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.prev_hash !== rows[i - 1]!.entry_hash) {
      firstBreak = Number(rows[i]!.seq);
      break;
    }
  }

  let mismatchSeq: number | null = null;
  if (rehash) {
    for (const r of rows) {
      if (!r.payload) continue;
      if (computeEntryHash(r.payload) !== r.entry_hash) {
        mismatchSeq = Number(r.seq);
        break;
      }
    }
  }

  // Does the period's first entry link to what came before it? At seq 1 that is genesis (D4).
  let linksToPredecessor: boolean | null = null;
  let predecessorSeq: number | null = null;
  let genesisVerified: boolean | null = null;
  if (seqFrom !== null) {
    if (seqFrom === 1) {
      genesisVerified = rows[0]!.prev_hash === genesisPrevHash(tenant);
      linksToPredecessor = genesisVerified;
    } else {
      const prev = await pool.query<{ seq: string; entry_hash: string }>(
        "SELECT seq, entry_hash FROM ledger_entries WHERE tenant_id = $1 AND seq = $2",
        [tenant, seqFrom - 1],
      );
      const p = prev.rows[0];
      predecessorSeq = p ? Number(p.seq) : null;
      linksToPredecessor = p ? rows[0]!.prev_hash === p.entry_hash : false;
    }
  }

  const cps = await pool.query<{
    id: string;
    seq_from: string;
    seq_to: string;
    merkle_root: string;
    signature: string;
    created_at: string;
  }>(
    `SELECT id, seq_from, seq_to, merkle_root, signature, ${tsCol("created_at")} AS created_at
       FROM checkpoints
      WHERE tenant_id = $1 AND seq_to >= $2 AND seq_from <= $3
      ORDER BY seq_from ASC`,
    [tenant, seqFrom ?? 0, seqTo ?? 0],
  );

  const anchors = readAnchorIds(anchorsLogPath);
  const anchorIds = new Set(anchors.ids);

  const covering: AttestationCheckpoint[] = cps.rows.map((c) => ({
    id: c.id,
    seq_from: Number(c.seq_from),
    seq_to: Number(c.seq_to),
    merkle_root: c.merkle_root,
    signature: c.signature,
    created_at: c.created_at,
    anchored_in_log: anchorIds.has(c.id),
  }));

  const period: SeqRange | null =
    seqFrom !== null && seqTo !== null ? { seq_from: seqFrom, seq_to: seqTo } : null;

  const sealed = period
    ? covering
        .map((c) => ({ c, r: intersect(period, { seq_from: c.seq_from, seq_to: c.seq_to }) }))
        .filter((x): x is { c: AttestationCheckpoint; r: SeqRange } => x.r !== null)
        .map((x) => ({ ...x.r, checkpoint_id: x.c.id, entries: countInRange(seqs, x.r) }))
    : [];

  const gaps = period
    ? uncoveredRanges(
        period,
        covering.map((c) => ({ seq_from: c.seq_from, seq_to: c.seq_to })),
      ).map((g) => ({ ...g, entries: countInRange(seqs, g) }))
    : [];

  const lastSealedTo = covering.reduce((m, c) => Math.max(m, c.seq_to), 0);
  const trailing =
    period && seqTo !== null && lastSealedTo < seqTo
      ? (() => {
          const r = { seq_from: Math.max(period.seq_from, lastSealedTo + 1), seq_to: seqTo };
          return { ...r, entries: countInRange(seqs, r) };
        })()
      : null;

  const entriesSealed = sealed.reduce((n, s) => n + s.entries, 0);

  return {
    chain: {
      entries: rows.length,
      seq_from: seqFrom,
      seq_to: seqTo,
      prev_hash_linkage_verified: firstBreak === null,
      first_break_seq: firstBreak,
      links_to_predecessor: linksToPredecessor,
      predecessor_seq: predecessorSeq,
      genesis_verified: genesisVerified,
      entry_hash_recomputed: rehash,
      entry_hash_mismatch_seq: mismatchSeq,
      note: rehash
        ? "Each entry's prev_hash was compared to its predecessor's entry_hash, and every entry_hash " +
          "was recomputed from its payload. This check runs inside the gate using the same " +
          "canonicalisation that wrote the entries; independent verification is the verifier CLI (D6)."
        : `The period holds more than ${MAX_REHASH_ENTRIES} entries, so this pack reports prev_hash ` +
          "linkage only and does not recompute entry hashes. Run the verifier CLI for a full " +
          "independent rehash.",
    },
    checkpoints: {
      covering,
      sealed_ranges: sealed,
      uncheckpointed_ranges: gaps,
      trailing_uncheckpointed: trailing,
      entries_sealed: entriesSealed,
      entries_not_sealed: rows.length - entriesSealed,
      note:
        gaps.length === 0
          ? "Every entry in this period falls inside a signed Merkle checkpoint."
          : "Sequence ranges listed under uncheckpointed_ranges are NOT yet sealed by a Merkle " +
            "checkpoint. They remain hash-chained, but they carry no signed root until the next " +
            "checkpoint is written (worker cadence: 5 minutes or 1,000 entries, D5). This is " +
            "expected for the most recent entries and is stated rather than smoothed over.",
    },
    anchors_log: {
      path: anchorsLogPath,
      present: anchors.present,
      lines: anchors.lines,
      checkpoint_ids: anchors.ids,
      note: anchors.present
        ? "anchors.log is the out-of-band record of sealed checkpoints (D5): one signed JSON line " +
          "per checkpoint. It is a local file, not WORM storage or a timestamping authority. " +
          "anchored_in_log on each checkpoint above shows whether that checkpoint appears in it."
        : "No anchors.log file was found at this path, so no out-of-band checkpoint record is " +
          "available to compare against the database.",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------------------------

export const PACK_HASH_COVERS =
  "sha256 over the RFC 8785 (JCS) canonicalisation of this document with two fields absent: " +
  "`pack_hash` itself, and `header.generated_at`. Excluding the generation stamp is deliberate — it " +
  "makes the hash a fingerprint of the EVIDENCE for the period rather than of the moment the report " +
  "was rendered, so regenerating the pack for the same period must reproduce the same hash. If it " +
  "does not, the underlying records changed.";

/** Compute the pack hash over everything except pack_hash and header.generated_at. */
export function computePackHash(pack: AttestationPack): string {
  const { pack_hash: _hash, header, ...rest } = pack;
  const { generated_at: _stamp, ...headerRest } = header;
  return jcsHashToken({ ...rest, header: headerRest });
}

export async function buildAttestationPack(
  pool: Pool,
  opts: BuildAttestationOptions,
): Promise<AttestationPack> {
  const w = await resolveWindow(pool, opts);
  const facts = await readHeaderFacts(pool, opts.tenant, w);
  const registry = await buildRegistry(pool, opts.tenant, w, opts.agentId);
  const enforcement = await buildEnforcement(pool, opts.tenant, w, opts.agentId);
  const makerChecker = await buildMakerChecker(pool, opts.tenant, w, opts.agentId);
  const integrity = await buildIntegrity(
    pool,
    opts.tenant,
    w,
    facts.entriesCovered,
    opts.anchorsLogPath ?? process.env.ANCHORS_LOG_PATH ?? "./anchors.log",
  );

  const pack: AttestationPack = {
    pack_type: "charter.attestation",
    pack_version: 1,
    header: {
      tenant_id: opts.tenant,
      tenant_name: facts.tenantName,
      period: { from: w.from, to: w.to },
      generated_at: w.generated_at,
      agent_filter: opts.agentId ?? null,
      policy: facts.policy,
      entries_covered: facts.entriesCovered,
      entries_by_kind: facts.entriesByKind,
      seq_range:
        integrity.chain.seq_from !== null && integrity.chain.seq_to !== null
          ? { from: integrity.chain.seq_from, to: integrity.chain.seq_to }
          : null,
      scope_note: opts.agentId
        ? `Registry, enforcement and maker-checker sections are restricted to agent '${opts.agentId}'. ` +
          "The evidence-integrity section is always tenant-wide, because the hash chain is per-tenant " +
          "(D4) and cannot be verified for one agent's entries in isolation."
        : "Whole-tenant scope. Entry counts cover every ledger entry kind in the period; enforcement " +
          "counts cover VERDICT entries only.",
    },
    registry: {
      agents: registry.agents,
      note:
        "Agents listed are those that a VERDICT entry attributes to them inside the period — the " +
        "registry as exercised, not the registry as configured. Charter status EXPIRED is derived " +
        "from the expiry date at read time, never stored. Grants shown are those whose validity " +
        "window overlaps the period; authorities_outside_period counts the agent's other versions.",
    },
    enforcement,
    maker_checker: makerChecker,
    evidence_integrity: integrity,
    control_mapping: CONTROL_MAPPING,
    limitations: { note: LIMITATIONS_NOTE, items: LIMITATIONS },
    pack_hash_covers: PACK_HASH_COVERS,
    pack_hash: "",
  };

  pack.pack_hash = computePackHash(pack);
  return pack;
}
