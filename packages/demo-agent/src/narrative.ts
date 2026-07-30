import { formatPaise } from "./money.js";
import type { StepRecord } from "./session.js";

/**
 * Human-readable narration of what the agent tried and what the gate said. The demo's whole value is
 * that the enforcement decision is legible, so this file is deliberately explicit: the tool + params,
 * the reasoning the agent gave, the verdict + rule_id + reason, the hold id, and the ledger entry id.
 */

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const wrap = (code: string, s: string): string => (useColor ? `[${code}m${s}[0m` : s);

export const style = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  red: (s: string) => wrap("31", s),
  cyan: (s: string) => wrap("36", s),
  magenta: (s: string) => wrap("35", s),
};

export function heading(title: string, subtitle?: string): void {
  const bar = "=".repeat(Math.min(88, Math.max(title.length + 4, 60)));
  console.log("");
  console.log(style.bold(bar));
  console.log(style.bold(`  ${title}`));
  if (subtitle) console.log(style.dim(`  ${subtitle}`));
  console.log(style.bold(bar));
}

export function section(title: string): void {
  console.log("");
  console.log(style.bold(`-- ${title} ${"-".repeat(Math.max(0, 76 - title.length))}`));
}

export function customerSays(text: string): void {
  console.log("");
  console.log(`${style.magenta("customer")} ${text}`);
}

export function agentThinks(text: string): void {
  console.log(`${style.cyan("agent   ")} ${style.dim(text)}`);
}

export function agentSays(text: string): void {
  console.log(`${style.cyan("agent   ")} ${text}`);
}

export function note(text: string): void {
  console.log(`${style.dim("note    ")} ${style.dim(text)}`);
}

export function warn(text: string): void {
  console.log(`${style.yellow("warn    ")} ${text}`);
}

export function fail(text: string): void {
  console.log(`${style.red("FAIL    ")} ${text}`);
}

export function pass(text: string): void {
  console.log(`${style.green("PASS    ")} ${text}`);
}

/** Amounts are the thing a reader checks first, so render params with ₹ alongside the paise. */
export function renderParams(params: Record<string, unknown>): string {
  const parts = Object.entries(params).map(([k, v]) => {
    if ((k === "amount" || k.endsWith("_minor")) && typeof v === "number" && Number.isInteger(v)) {
      return `${k}=${v} [${formatPaise(v)}]`;
    }
    if (typeof v === "string") return `${k}=${v.length > 48 ? JSON.stringify(v.slice(0, 45) + "…") : v}`;
    return `${k}=${JSON.stringify(v)}`;
  });
  return parts.join(" ");
}

function verdictBadge(step: StepRecord): string {
  switch (step.verdict) {
    case "ALLOW":
      return style.green("ALLOW   ");
    case "ESCALATE":
      return style.yellow("ESCALATE");
    case "DENY":
      return style.red("DENY    ");
    default:
      return style.red("NO-VERDICT");
  }
}

function outcomeText(step: StepRecord): string {
  switch (step.outcome) {
    case "EXECUTED":
      return style.green("tool ran");
    case "DENIED":
      return style.red("tool did NOT run");
    case "HELD":
      return style.yellow("tool did NOT run — waiting on a human");
    case "REJECTED":
      return style.red("tool did NOT run — approver rejected");
    case "EXPIRED":
      return style.red("tool did NOT run — hold expired");
    case "ERROR":
      return style.red("tool did NOT run — error (fail closed)");
  }
}

/** One block per attempted tool call. This is the demo's core output. */
export function printStep(step: StepRecord): void {
  console.log("");
  console.log(`  ${style.bold(`[${step.n}] ${step.tool}`)}  ${style.dim(renderParams(step.params))}`);
  console.log(`      ${style.dim("reasoning:")} ${step.reasoning}`);
  console.log(`      ${style.dim("principal:")} ${step.principal}`);
  console.log(
    `      gate: ${verdictBadge(step)} rule=${step.rule_id ?? "-"}` +
      `${step.reason ? ` reason="${step.reason}"` : ""}`,
  );
  if (step.hold_id) {
    const decided = step.decidedByDemo ? ` → demo released it as ${step.decidedByDemo}` : "";
    console.log(
      `      hold: ${step.hold_id} ttl=${step.ttl_minutes ?? "?"}m${decided}`,
    );
  }
  console.log(`      ledger: entry_id=${step.entry_id ?? "-"}`);
  console.log(`      result: ${outcomeText(step)}${step.error ? ` — ${style.dim(step.error)}` : ""}`);
  if (step.outcome === "EXECUTED" && step.result !== undefined) {
    console.log(`      ${style.dim(`returned: ${truncate(JSON.stringify(step.result), 140)}`)}`);
  }
  console.log(`      ${style.dim(`latency: ${step.latencyMs}ms`)}`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Compact end-of-scenario table: what was attempted, what the gate did, which entry proves it. */
export function printLedgerSummary(steps: readonly StepRecord[]): void {
  section("ledger entries written by this run");
  if (steps.length === 0) {
    console.log("  (none)");
    return;
  }
  console.log(
    style.dim("  #   tool             verdict   rule                          outcome    entry_id"),
  );
  for (const s of steps) {
    console.log(
      "  " +
        [
          String(s.n).padEnd(3),
          s.tool.padEnd(16),
          (s.verdict ?? "-").padEnd(9),
          (s.rule_id ?? "-").padEnd(29),
          s.outcome.padEnd(10),
          s.entry_id ?? "-",
        ].join(" "),
    );
  }
}
