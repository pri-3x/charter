import type {
  AttestationEscalation,
  AttestationPack,
  ControlMappingRow,
  MoneyTotal,
} from "./types.js";

/**
 * Printable HTML rendering of the evidence pack.
 *
 * Design brief, deliberately narrow: this is an official document, not a dashboard. Serif body,
 * ruled tables, no colour beyond black/grey plus one restrained accent for warnings, no external
 * assets of any kind (a strict CSP would block them and a printed PDF must not depend on a network).
 * Every section is page-break-friendly and the pack hash repeats in the running footer so the PDF a
 * human prints is itself checkable against the JSON.
 */

const AMOUNT_FMT = new Intl.NumberFormat("en-IN");

function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dash(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : esc(value);
}

/** Minor units → major units with grouping, e.g. 10000000 INR → "1,00,000.00". */
function major(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}${AMOUNT_FMT.format(whole)}.${cents}`;
}

function moneyRows(label: string, totals: MoneyTotal[]): string {
  if (totals.length === 0) {
    return `<tr><td>${esc(label)}</td><td colspan="3" class="muted">no monetary actions</td></tr>`;
  }
  return totals
    .map(
      (t, i) => `<tr>
      <td>${i === 0 ? esc(label) : ""}</td>
      <td>${esc(t.currency)}</td>
      <td class="num">${esc(t.total_minor)}</td>
      <td class="num">${esc(major(t.total_minor))} <span class="muted">(${esc(t.actions)} action${t.actions === 1 ? "" : "s"})</span></td>
    </tr>`,
    )
    .join("");
}

function statusChip(status: AttestationEscalation["hold_status"]): string {
  const cls =
    status === "APPROVED"
      ? "ok"
      : status === "REJECTED" || status === "EXPIRED"
        ? "blocked"
        : status === "PENDING"
          ? "open"
          : "warn";
  return `<span class="chip ${cls}">${esc(status)}</span>`;
}

function controlRows(rows: ControlMappingRow[]): string {
  return rows
    .map(
      (r) => `<tr>
      <td><span class="fw">${esc(r.framework)}</span><div class="ref">${esc(r.control_reference)}</div></td>
      <td>${esc(r.expectation)}</td>
      <td>${esc(r.charter_evidence)}</td>
      <td>${r.proof_location.map((p) => `<code>${esc(p)}</code>`).join("<br>")}</td>
    </tr>`,
    )
    .join("");
}

const STYLE = `
:root { --ink:#111; --mid:#4a4a4a; --faint:#767676; --rule:#c8c8c8; --hair:#e4e4e4; --warn:#8a1f11; }
* { box-sizing: border-box; }
body { margin:0; padding:0 0 26mm; color:var(--ink); background:#fff;
  font-family: "Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
  font-size: 10.5pt; line-height: 1.45; }
.page { max-width: 190mm; margin: 0 auto; padding: 14mm 12mm 0; }
h1 { font-size: 19pt; margin: 0 0 2mm; letter-spacing: -0.01em; }
h2 { font-size: 12.5pt; margin: 9mm 0 3mm; padding-bottom: 1.4mm; border-bottom: 1.2pt solid var(--ink);
  page-break-after: avoid; break-after: avoid; }
h3 { font-size: 10.5pt; margin: 5mm 0 2mm; page-break-after: avoid; break-after: avoid; }
p { margin: 0 0 3mm; }
.doctype { font-family: ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size: 7.6pt;
  letter-spacing: .16em; text-transform: uppercase; color: var(--faint); margin: 0 0 1.5mm; }
.subtitle { color: var(--mid); font-size: 10pt; margin: 0 0 4mm; }
.rule-top { border-bottom: 2.4pt solid var(--ink); margin-bottom: 5mm; }
table { width:100%; border-collapse: collapse; margin: 0 0 4mm; font-size: 9.4pt; }
th, td { text-align: left; vertical-align: top; padding: 1.6mm 2.4mm; border-bottom: .5pt solid var(--hair); }
thead th { border-bottom: 1pt solid var(--rule); font-size: 8.4pt; text-transform: uppercase;
  letter-spacing: .07em; color: var(--mid); font-weight: 600; }
tbody tr:last-child td { border-bottom: 1pt solid var(--rule); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums;
  font-family: ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size: 8.8pt; }
code, .mono { font-family: ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size: 8.4pt; word-break: break-all; }
.muted { color: var(--faint); }
.kv { width:100%; }
.kv td:first-child { width: 42mm; color: var(--mid); }
section { page-break-inside: auto; break-inside: auto; }
.block { page-break-inside: avoid; break-inside: avoid; }
tr, thead { page-break-inside: avoid; break-inside: avoid; }
thead { display: table-header-group; }
.chip { display:inline-block; padding: .2mm 1.6mm; border: .6pt solid var(--rule); border-radius: 1mm;
  font-size: 8pt; font-family: ui-monospace,Menlo,monospace; letter-spacing: .04em; }
.chip.ok { border-color:#2d6a4f; color:#2d6a4f; }
.chip.blocked { border-color: var(--warn); color: var(--warn); }
.chip.open { border-color:#8a6d1f; color:#8a6d1f; }
.chip.warn { border-color: var(--warn); color:#fff; background: var(--warn); }
.statement { margin: 0 0 2.5mm; padding-left: 4mm; border-left: 1.6pt solid var(--rule); color: var(--ink); }
.statement.alarm { border-left-color: var(--warn); color: var(--warn); }
ol.lim { margin: 0 0 3mm; padding-left: 6mm; }
ol.lim li { margin-bottom: 2.4mm; }
.fw { font-weight: 600; }
.ref { color: var(--faint); font-size: 8.4pt; margin-top: .8mm; }
.hashline { font-family: ui-monospace,Menlo,monospace; font-size: 8.6pt; word-break: break-all;
  border: .6pt solid var(--rule); padding: 2.4mm; background: #fafafa; }
.footer { position: fixed; left: 0; right: 0; bottom: 0; height: 16mm; padding: 2mm 12mm 0;
  border-top: .5pt solid var(--rule); background: #fff; color: var(--faint);
  font-family: ui-monospace,Menlo,monospace; font-size: 7.2pt; line-height: 1.35; }
.footer .l { float: left; } .footer .r { float: right; }
@media print {
  body { padding-bottom: 20mm; }
  .page { max-width: none; margin: 0; padding: 0; }
  a { color: inherit; text-decoration: none; }
}
@page { size: A4; margin: 14mm 14mm 22mm; }
`;

export function renderAttestationHtml(pack: AttestationPack): string {
  const h = pack.header;
  const e = pack.enforcement;
  const mc = pack.maker_checker;
  const ig = pack.evidence_integrity;
  const title = `Charter attestation — ${h.tenant_name ?? h.tenant_id}`;

  const kindRows = Object.entries(h.entries_by_kind)
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${esc(v)}</td></tr>`)
    .join("");

  const agentBlocks = pack.registry.agents
    .map((a) => {
      const grants =
        a.authorities_in_force.length === 0
          ? `<p class="muted">No authority grant overlapped this period.</p>`
          : `<table><thead><tr><th>Grant</th><th>Grantor</th><th>Validity</th><th>Budget</th><th>Forbidden operations</th><th>Document hash</th></tr></thead><tbody>${a.authorities_in_force
              .map(
                (g) => `<tr>
            <td><span class="fw">${esc(g.ref)}</span> <span class="muted">v${esc(g.version)}</span><br>${statusChipRaw(g.status)}</td>
            <td>${dash(g.grantor_principal)}</td>
            <td class="mono">${esc(g.valid_from)}<br>→ ${esc(g.valid_until)}${
              g.revoked_at ? `<br><span class="chip blocked">revoked ${esc(g.revoked_at)}</span>` : ""
            }</td>
            <td>${
              g.budget
                ? `<span class="mono">${esc(g.budget.minor)}</span> ${esc(g.budget.currency)}<br><span class="muted">${esc(
                    major(g.budget.minor),
                  )} per ${esc(g.budget.window_minutes)} min</span>`
                : '<span class="muted">no ceiling</span>'
            }</td>
            <td>${g.forbidden_ops.length ? g.forbidden_ops.map((o) => `<code>${esc(o)}</code>`).join(", ") : '<span class="muted">none</span>'}</td>
            <td><code>${esc(g.doc_hash)}</code></td>
          </tr>`,
              )
              .join("")}</tbody></table>`;
      return `<div class="block">
      <h3>${esc(a.id)}${a.name ? ` — ${esc(a.name)}` : ""} ${statusChipRaw(a.charter.charter_status)}${
        a.registry_record_missing ? ' <span class="chip warn">no registry record</span>' : ""
      }</h3>
      <table class="kv"><tbody>
        <tr><td>Accountable owner</td><td>${dash(a.charter.owner_name)} ${a.charter.owner_principal ? `<span class="muted mono">${esc(a.charter.owner_principal)}</span>` : ""}</td></tr>
        <tr><td>Department</td><td>${dash(a.charter.department)}</td></tr>
        <tr><td>Purpose</td><td>${dash(a.charter.purpose)}</td></tr>
        <tr><td>Charter expiry</td><td class="mono">${dash(a.charter.expires_at)}</td></tr>
        <tr><td>Autonomy cap</td><td>${dash(a.charter.max_autonomy)}</td></tr>
        <tr><td>Approver chain</td><td>${a.charter.approver_chain.length ? a.charter.approver_chain.map((p) => `<code>${esc(p)}</code>`).join(", ") : '<span class="muted">—</span>'}</td></tr>
        <tr><td>Actions in period</td><td>${esc(a.period_activity.total)} <span class="muted">(${esc(a.period_activity.ALLOW)} allowed · ${esc(a.period_activity.DENY)} denied · ${esc(a.period_activity.ESCALATE)} escalated)</span></td></tr>
        <tr><td>Other grant versions</td><td>${esc(a.authorities_outside_period)} <span class="muted">outside this period</span></td></tr>
      </tbody></table>
      ${grants}
    </div>`;
    })
    .join("");

  const escalationRows =
    mc.escalations.length === 0
      ? `<tr><td colspan="8" class="muted">No action was escalated in this period.</td></tr>`
      : mc.escalations
          .map(
            (x) => `<tr>
      <td class="num">${esc(x.seq)}</td>
      <td class="mono">${esc(x.ts)}</td>
      <td>${dash(x.agent_id)}<br><span class="muted">${dash(x.tool)}</span></td>
      <td class="num">${x.amount_minor === null ? "—" : esc(x.amount_minor)}${x.currency ? `<br><span class="muted">${esc(x.currency)}</span>` : ""}</td>
      <td>${dash(x.initiating_principal ?? x.principal)}</td>
      <td>${statusChip(x.hold_status)}${x.denied_by_timeout ? '<br><span class="muted">denied on timeout</span>' : ""}</td>
      <td>${dash(x.decided_by)}${x.self_approval ? '<br><span class="chip warn">SELF-APPROVAL</span>' : ""}</td>
      <td class="num">${x.decision_latency_seconds === null ? "—" : esc(x.decision_latency_seconds)}</td>
    </tr>`,
          )
          .join("");

  const gapRows =
    ig.checkpoints.uncheckpointed_ranges.length === 0
      ? `<tr><td colspan="3" class="muted">None — every entry in the period is sealed.</td></tr>`
      : ig.checkpoints.uncheckpointed_ranges
          .map(
            (g) =>
              `<tr><td class="num">${esc(g.seq_from)}</td><td class="num">${esc(g.seq_to)}</td><td class="num">${esc(g.entries)}</td></tr>`,
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">

  <header class="block">
    <div class="doctype">Charter · runtime authorisation evidence pack</div>
    <h1>Agent authorisation attestation</h1>
    <p class="subtitle">${esc(h.tenant_name ?? h.tenant_id)} · reporting period ${esc(h.period.from)} to ${esc(h.period.to)}</p>
    <div class="rule-top"></div>
    <table class="kv"><tbody>
      <tr><td>Tenant</td><td>${esc(h.tenant_name ?? "—")} <span class="muted mono">${esc(h.tenant_id)}</span></td></tr>
      <tr><td>Period</td><td class="mono">${esc(h.period.from)} → ${esc(h.period.to)}</td></tr>
      <tr><td>Generated</td><td class="mono">${esc(h.generated_at)} <span class="muted">(Postgres now())</span></td></tr>
      <tr><td>Scope filter</td><td>${h.agent_filter ? `agent <code>${esc(h.agent_filter)}</code>` : "whole tenant"}</td></tr>
      <tr><td>Policy in force</td><td>${h.policy.version === null ? '<span class="muted">none active</span>' : `version ${esc(h.policy.version)}`}${
        h.policy.doc_hash ? `<br><code>${esc(h.policy.doc_hash)}</code>` : ""
      }${h.policy.activated_at ? `<br><span class="muted mono">activated ${esc(h.policy.activated_at)}</span>` : ""}</td></tr>
      <tr><td>Ledger entries covered</td><td>${esc(h.entries_covered)}${
        h.seq_range ? ` <span class="muted">(seq ${esc(h.seq_range.from)}–${esc(h.seq_range.to)})</span>` : ""
      }</td></tr>
    </tbody></table>
    <p class="muted">${esc(h.scope_note)}</p>
  </header>

  <section>
    <h2>1 · Entries covered, by kind</h2>
    <table><thead><tr><th>Entry kind</th><th class="num">Count</th></tr></thead>
    <tbody>${kindRows || '<tr><td colspan="2" class="muted">No entries in this period.</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>2 · Registry — chartered agents that acted in the period</h2>
    <p class="muted">${esc(pack.registry.note)}</p>
    ${agentBlocks || '<p class="muted">No agent acted in this period.</p>'}
  </section>

  <section>
    <h2>3 · Enforcement summary</h2>
    <div class="block">
      <table><thead><tr><th>Verdict</th><th class="num">Count</th></tr></thead><tbody>
        <tr><td>ALLOW</td><td class="num">${esc(e.by_verdict.ALLOW)}</td></tr>
        <tr><td>DENY</td><td class="num">${esc(e.by_verdict.DENY)}</td></tr>
        <tr><td>ESCALATE</td><td class="num">${esc(e.by_verdict.ESCALATE)}</td></tr>
      </tbody></table>
    </div>
    <h3>By tool</h3>
    <table><thead><tr><th>Tool</th><th class="num">Allow</th><th class="num">Deny</th><th class="num">Escalate</th><th class="num">Total</th></tr></thead><tbody>
      ${
        e.by_tool
          .map(
            (t) =>
              `<tr><td><code>${esc(t.tool)}</code></td><td class="num">${esc(t.ALLOW)}</td><td class="num">${esc(t.DENY)}</td><td class="num">${esc(t.ESCALATE)}</td><td class="num">${esc(t.total)}</td></tr>`,
          )
          .join("") || '<tr><td colspan="5" class="muted">No verdicts in this period.</td></tr>'
      }
    </tbody></table>
    <h3>By rule</h3>
    <table><thead><tr><th>Rule</th><th>Verdict</th><th class="num">Count</th></tr></thead><tbody>
      ${
        e.by_rule
          .map(
            (r) =>
              `<tr><td><code>${esc(r.rule_id)}</code></td><td>${esc(r.verdict)}</td><td class="num">${esc(r.count)}</td></tr>`,
          )
          .join("") || '<tr><td colspan="3" class="muted">No verdicts in this period.</td></tr>'
      }
    </tbody></table>
    <h3>Money authorised versus refused</h3>
    <table><thead><tr><th>Verdict</th><th>Currency</th><th class="num">Minor units</th><th class="num">Major units</th></tr></thead><tbody>
      ${moneyRows("ALLOWED", e.money.allowed)}
      ${moneyRows("DENIED", e.money.denied)}
      ${moneyRows("ESCALATED", e.money.escalated)}
    </tbody></table>
    <p class="muted">${esc(e.money.note)}</p>
    <h3>Leading denial reasons</h3>
    <table><thead><tr><th>Rule</th><th>Reason recorded</th><th class="num">Count</th></tr></thead><tbody>
      ${
        e.top_denial_reasons
          .map(
            (d) =>
              `<tr><td><code>${esc(d.rule_id)}</code></td><td>${dash(d.reason)}</td><td class="num">${esc(d.count)}</td></tr>`,
          )
          .join("") || '<tr><td colspan="3" class="muted">No denials in this period.</td></tr>'
      }
    </tbody></table>
  </section>

  <section>
    <h2>4 · Maker-checker — human decisions on escalated actions</h2>
    <div class="block">
      <table class="kv"><tbody>
        <tr><td>Escalated actions</td><td>${esc(mc.summary.total)}</td></tr>
        <tr><td>Resolved</td><td>${esc(mc.summary.resolved)} — approved ${esc(mc.summary.APPROVED)}, rejected ${esc(mc.summary.REJECTED)}, expired ${esc(mc.summary.EXPIRED)}</td></tr>
        <tr><td>Still pending</td><td>${esc(mc.summary.PENDING)}</td></tr>
        <tr><td>Denied by timeout</td><td>${esc(mc.summary.expired_denied_by_timeout)}</td></tr>
        <tr><td>Self-approvals</td><td>${mc.summary.no_self_approval ? '0 <span class="chip ok">none</span>' : `${esc(mc.summary.self_approvals)} <span class="chip warn">investigate</span>`}</td></tr>
        <tr><td>Hold row vs ledger</td><td>${mc.summary.ledger_disagreements === 0 ? '<span class="chip ok">agree</span>' : `${esc(mc.summary.ledger_disagreements)} <span class="chip warn">disagreement</span>`}</td></tr>
        <tr><td>Decision latency (s)</td><td>${
          mc.summary.latency_seconds
            ? `min ${esc(mc.summary.latency_seconds.min)} · median ${esc(mc.summary.latency_seconds.median)} · max ${esc(mc.summary.latency_seconds.max)}`
            : '<span class="muted">no resolved holds</span>'
        }</td></tr>
      </tbody></table>
      ${mc.statements
        .map(
          (s) =>
            `<p class="statement${s.startsWith("WARNING") || s.startsWith("A defect") ? " alarm" : ""}">${esc(s)}</p>`,
        )
        .join("")}
    </div>
    <table><thead><tr><th class="num">Seq</th><th>Recorded</th><th>Agent / tool</th><th class="num">Amount</th><th>Initiated by</th><th>Outcome</th><th>Decided by</th><th class="num">Latency (s)</th></tr></thead>
    <tbody>${escalationRows}</tbody></table>
  </section>

  <section>
    <h2>5 · Evidence integrity</h2>
    <div class="block">
      <h3>Hash chain over the period</h3>
      <table class="kv"><tbody>
        <tr><td>Entries checked</td><td>${esc(ig.chain.entries)}${
          ig.chain.seq_from !== null ? ` <span class="muted">(seq ${esc(ig.chain.seq_from)}–${esc(ig.chain.seq_to)})</span>` : ""
        }</td></tr>
        <tr><td>prev_hash linkage</td><td>${
          ig.chain.prev_hash_linkage_verified
            ? '<span class="chip ok">continuous</span>'
            : `<span class="chip warn">break at seq ${esc(ig.chain.first_break_seq)}</span>`
        }</td></tr>
        <tr><td>Links to predecessor</td><td>${
          ig.chain.links_to_predecessor === null
            ? '<span class="muted">no entries</span>'
            : ig.chain.links_to_predecessor
              ? `<span class="chip ok">yes</span> <span class="muted">${
                  ig.chain.genesis_verified ? "genesis (seq 1)" : `seq ${esc(ig.chain.predecessor_seq)}`
                }</span>`
              : '<span class="chip warn">no</span>'
        }</td></tr>
        <tr><td>entry_hash recomputed</td><td>${
          ig.chain.entry_hash_recomputed
            ? ig.chain.entry_hash_mismatch_seq === null
              ? '<span class="chip ok">all match</span>'
              : `<span class="chip warn">mismatch at seq ${esc(ig.chain.entry_hash_mismatch_seq)}</span>`
            : '<span class="muted">skipped (period too large)</span>'
        }</td></tr>
      </tbody></table>
      <p class="muted">${esc(ig.chain.note)}</p>
    </div>

    <h3>Merkle checkpoint coverage</h3>
    <table><thead><tr><th>Checkpoint</th><th class="num">Seq from</th><th class="num">Seq to</th><th>Merkle root</th><th>Ed25519 signature</th><th>Anchored</th></tr></thead><tbody>
      ${
        ig.checkpoints.covering
          .map(
            (c) => `<tr>
        <td><code>${esc(c.id)}</code><br><span class="muted mono">${esc(c.created_at)}</span></td>
        <td class="num">${esc(c.seq_from)}</td><td class="num">${esc(c.seq_to)}</td>
        <td><code>${esc(c.merkle_root)}</code></td>
        <td><code>${esc(c.signature)}</code></td>
        <td>${c.anchored_in_log ? '<span class="chip ok">in log</span>' : '<span class="chip open">not in log</span>'}</td>
      </tr>`,
          )
          .join("") ||
        '<tr><td colspan="6" class="muted">No checkpoint covers any part of this period.</td></tr>'
      }
    </tbody></table>
    <div class="block">
      <h3>Sequence ranges NOT yet sealed by a checkpoint</h3>
      <table><thead><tr><th class="num">Seq from</th><th class="num">Seq to</th><th class="num">Entries</th></tr></thead><tbody>${gapRows}</tbody></table>
      <table class="kv"><tbody>
        <tr><td>Entries sealed</td><td>${esc(ig.checkpoints.entries_sealed)}</td></tr>
        <tr><td>Entries not sealed</td><td>${esc(ig.checkpoints.entries_not_sealed)}</td></tr>
        <tr><td>Trailing unsealed run</td><td>${
          ig.checkpoints.trailing_uncheckpointed
            ? `seq ${esc(ig.checkpoints.trailing_uncheckpointed.seq_from)}–${esc(ig.checkpoints.trailing_uncheckpointed.seq_to)} (${esc(ig.checkpoints.trailing_uncheckpointed.entries)} entries)`
            : '<span class="muted">none</span>'
        }</td></tr>
      </tbody></table>
      <p class="muted">${esc(ig.checkpoints.note)}</p>
    </div>
    <div class="block">
      <h3>Out-of-band anchor record</h3>
      <table class="kv"><tbody>
        <tr><td>Path</td><td class="mono">${esc(ig.anchors_log.path)}</td></tr>
        <tr><td>File present</td><td>${ig.anchors_log.present ? "yes" : "no"}</td></tr>
        <tr><td>Anchored checkpoints</td><td>${esc(ig.anchors_log.lines)}</td></tr>
      </tbody></table>
      <p class="muted">${esc(ig.anchors_log.note)}</p>
    </div>
  </section>

  <section>
    <h2>6 · Control mapping</h2>
    <p>Each row states a control expectation, what Charter <em>evidences</em> for it, and where in the
    machine-readable pack that evidence sits. These are evidence mappings, not attestations of
    compliance: whether a control is satisfied is an assessor's conclusion, not this document's.</p>
    <table><thead><tr><th>Framework &amp; reference</th><th>Expectation</th><th>What Charter evidences</th><th>Where in this pack</th></tr></thead>
    <tbody>${controlRows(pack.control_mapping)}</tbody></table>
  </section>

  <section>
    <h2>7 · Limitations of this evidence</h2>
    <p>${esc(pack.limitations.note)}</p>
    <ol class="lim">${pack.limitations.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>
  </section>

  <section class="block">
    <h2>8 · Integrity of this pack</h2>
    <p>The hash below is computed over the canonical JSON form of this pack, so a printed or archived
    copy can be checked against the machine-readable response from
    <code>GET /v1/attestation?format=json</code>.</p>
    <div class="hashline">${esc(pack.pack_hash)}</div>
    <p class="muted" style="margin-top:3mm">${esc(pack.pack_hash_covers)}</p>
  </section>
</div>

<div class="footer">
  <span class="l">${esc(h.tenant_id)} · ${esc(h.period.from)} → ${esc(h.period.to)} · generated ${esc(h.generated_at)}</span>
  <span class="r">${esc(pack.pack_hash)}</span>
</div>
</body>
</html>
`;
}

/** Status chips for registry/authority values, which are plain strings rather than hold statuses. */
function statusChipRaw(status: string): string {
  const cls =
    status === "ACTIVE"
      ? "ok"
      : status === "EXPIRED" || status === "REVOKED"
        ? "blocked"
        : status === "SUPERSEDED" || status === "SUSPENDED"
          ? "open"
          : "warn";
  return `<span class="chip ${cls}">${esc(status)}</span>`;
}
