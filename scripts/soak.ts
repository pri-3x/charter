import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_EDGES,
  LedgerReader,
  agentKey,
  formatPaise,
  histogram,
  loadDemoConfig,
  newRunTag,
  renderHistogram,
  summarize,
  verifyChainLinks,
  DemoConfigError,
  requireHealthyGate,
  style,
} from "@charter/demo-agent";

/**
 * S20 soak — `npm run soak`.
 *
 * 1,000 checks at ~50/sec of mixed S1 / S3 / S9 shapes; assert 0 errors, p50 <= 50ms, p99 <= 150ms;
 * print the latency histogram; then verify the chain the run wrote links cleanly
 * (prev_hash[n] == entry_hash[n-1]).
 *
 * NOT part of the default integration suite, deliberately: it writes thousands of ledger entries and
 * would pollute every test run (CLAUDE.md — ledger tables are INSERT-only, so there is no cleanup).
 *
 * Two properties keep it repeatable:
 *  - it runs as `support-agent`, whose authority grant carries a deliberately high daily ceiling, so
 *    soak volume cannot trip the budget check;
 *  - every check uses a unique principal, so R5's per-principal 24h velocity sum cannot accumulate
 *    across the run and start escalating the S1-shaped requests.
 */

const SOAK_AGENT = "support-agent";
const DEFAULT_TOTAL = 1_000;
const DEFAULT_RATE = 50; // requests per second
const P50_BUDGET_MS = 50;
const P99_BUDGET_MS = 150;

/** Mixed shapes, in the proportions the plan calls for: mostly S1, with S3 and S9 mixed in. */
const MIX = [
  { name: "S1 refund 20,000 → ALLOW", weight: 6 },
  { name: "S3 refund 500,100 → ESCALATE", weight: 2 },
  { name: "S9 delete_record → DENY", weight: 2 },
] as const;

interface Shape {
  label: string;
  tool: string;
  params: Record<string, unknown>;
  /** Unique per request — see the note about R5 at the top of this file. */
  principal: string;
}

const MIX_TOTAL = MIX.reduce((n, m) => n + m.weight, 0);

function shapeFor(i: number, runTag: string): Shape {
  const slot = i % MIX_TOTAL;
  const principal = `user:soak-${runTag}-${i}@example.com`;
  if (slot < MIX[0]!.weight) {
    return {
      label: MIX[0]!.name,
      tool: "refund",
      params: { order_id: "ORD-4471", amount: 20_000, currency: "INR", reason: "soak" },
      principal,
    };
  }
  if (slot < MIX[0]!.weight + MIX[1]!.weight) {
    return {
      label: MIX[1]!.name,
      tool: "refund",
      params: { order_id: "ORD-4475", amount: 500_100, currency: "INR", reason: "soak" },
      principal,
    };
  }
  return {
    label: MIX[2]!.name,
    tool: "delete_record",
    params: { record_type: "customer", record_id: `CUST-${90_000 + (i % 999)}` },
    principal,
  };
}

interface Sample {
  /** Client-side round trip, including scheduling and JSON on both ends. */
  ms: number;
  /** The gate's own eval+commit time from its Server-Timing header — what S20's budget is about. */
  gateMs?: number;
  verdict?: string;
  rule_id?: string;
  status: number;
  error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const total = Number(process.env.SOAK_TOTAL ?? DEFAULT_TOTAL);
  const rate = Number(process.env.SOAK_RATE ?? DEFAULT_RATE);
  if (!Number.isInteger(total) || total <= 0) throw new DemoConfigError("SOAK_TOTAL must be a positive integer");
  if (!Number.isFinite(rate) || rate <= 0) throw new DemoConfigError("SOAK_RATE must be positive");

  const config = loadDemoConfig();
  const health = await requireHealthyGate(config.baseUrl);
  const apiKey = agentKey(config.seed, SOAK_AGENT);
  const runTag = newRunTag();
  const url = `${config.baseUrl.replace(/\/$/, "")}/v1/actions/check`;

  const reader = new LedgerReader({
    baseUrl: config.baseUrl,
    adminKey: config.seed.adminKey,
    tenant: config.seed.tenant,
  });
  const startSeq = await reader.headSeq();

  console.log("");
  console.log(style.bold("S20 soak"));
  console.log(
    `  gate=${config.baseUrl} · active policy v${health.activePolicyVersion ?? "?"} · agent=${SOAK_AGENT}`,
  );
  console.log(`  ${total} checks at ~${rate}/sec · run-tag=${runTag} · ledger head before: seq ${startSeq}`);
  console.log(`  budgets: p50 <= ${P50_BUDGET_MS}ms, p99 <= ${P99_BUDGET_MS}ms, 0 errors`);
  console.log("");

  const samples: Sample[] = [];
  const inflight: Array<Promise<void>> = [];
  const intervalMs = 1000 / rate;
  const wallStart = performance.now();

  for (let i = 0; i < total; i++) {
    const shape = shapeFor(i, runTag);
    const scheduled = wallStart + i * intervalMs;
    const wait = scheduled - performance.now();
    if (wait > 0) await sleep(wait);

    inflight.push(
      (async () => {
        const t0 = performance.now();
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "Idempotency-Key": `soak-${runTag}-${i}-${randomUUID()}`,
            },
            body: JSON.stringify({
              tool: shape.tool,
              params: shape.params,
              principal: shape.principal,
              context: { reasoning: `soak ${shape.label}`, conversation_ref: `soak/${runTag}` },
            }),
          });
          const ms = performance.now() - t0;
          // The budget in TEST_PLAN S20 is on the gate's ADDED latency ("evaluation+commit"), which
          // the gate reports per request in Server-Timing. Round trip is recorded too, but it also
          // contains client scheduling, connection pickup and JSON handling on both sides — holding
          // the gate to that number would be measuring Node's fetch as much as the gate.
          const timing = res.headers.get("Server-Timing");
          const gateMsRaw = timing ? Number(/dur=([\d.]+)/.exec(timing)?.[1] ?? NaN) : NaN;
          const gateMs = Number.isFinite(gateMsRaw) ? gateMsRaw : undefined;
          if (res.status !== 200) {
            samples.push({ ms, status: res.status, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` });
            return;
          }
          const body = (await res.json()) as { verdict?: string; rule_id?: string };
          samples.push({
            ms,
            status: 200,
            ...(gateMs !== undefined ? { gateMs } : {}),
            ...(body.verdict ? { verdict: body.verdict } : {}),
            ...(body.rule_id ? { rule_id: body.rule_id } : {}),
          });
        } catch (err) {
          samples.push({ ms: performance.now() - t0, status: 0, error: String(err) });
        }
      })(),
    );

    if ((i + 1) % 100 === 0) {
      process.stdout.write(`  sent ${i + 1}/${total}\r`);
    }
  }

  await Promise.all(inflight);
  const wallMs = performance.now() - wallStart;
  process.stdout.write(" ".repeat(30) + "\r");

  const errors = samples.filter((s) => s.error !== undefined);
  const latencies = samples.map((s) => s.ms);
  const stats = summarize(latencies);
  const gateLatencies = samples.map((s) => s.gateMs).filter((n): n is number => n !== undefined);
  // Fall back to round trip only if the gate stopped reporting Server-Timing — never silently pass
  // a budget check on data that is not there.
  const gateStats = gateLatencies.length > 0 ? summarize(gateLatencies) : stats;
  const gateMeasured = gateLatencies.length > 0;

  const byVerdict = new Map<string, number>();
  for (const s of samples) {
    const key = s.error ? "ERROR" : (s.verdict ?? "?");
    byVerdict.set(key, (byVerdict.get(key) ?? 0) + 1);
  }

  console.log(style.bold("  results"));
  console.log(`    requests:      ${samples.length} in ${(wallMs / 1000).toFixed(1)}s (${(samples.length / (wallMs / 1000)).toFixed(1)}/sec observed)`);
  console.log(`    errors:        ${errors.length}`);
  console.log(
    `    verdicts:      ${[...byVerdict.entries()].map(([k, v]) => `${k}=${v}`).join("  ")}`,
  );
  console.log(
    `    gate eval+commit (ms, budgeted): p50=${gateStats.p50.toFixed(1)} p90=${gateStats.p90.toFixed(1)} ` +
      `p95=${gateStats.p95.toFixed(1)} p99=${gateStats.p99.toFixed(1)} max=${gateStats.max.toFixed(1)}` +
      (gateMeasured ? "" : "  (Server-Timing absent — round trip shown)"),
  );
  console.log(
    `    round trip (ms, informational): min=${stats.min.toFixed(1)} p50=${stats.p50.toFixed(1)} ` +
      `p95=${stats.p95.toFixed(1)} p99=${stats.p99.toFixed(1)} max=${stats.max.toFixed(1)} mean=${stats.mean.toFixed(1)}`,
  );
  console.log("");
  console.log(style.bold("  latency histogram"));
  for (const line of renderHistogram(histogram(latencies, DEFAULT_EDGES))) console.log(line);

  if (errors.length > 0) {
    console.log("");
    console.log(style.red("  first errors:"));
    for (const e of errors.slice(0, 5)) console.log(`    ${e.error}`);
  }

  // ---- chain integrity over everything the soak wrote --------------------------------------
  console.log("");
  console.log(style.bold("  chain integrity"));
  const entries = await reader.entriesFrom(Math.max(0, startSeq));
  const chain = verifyChainLinks(entries);
  console.log(
    `    ${chain.ok ? style.green("OK") : style.red("BROKEN")}  ${chain.detail} (${chain.checked} entries read)`,
  );
  console.log(`    (full-chain + checkpoint + Ed25519 verification: npm run verify)`);

  // ---- verdict -----------------------------------------------------------------------------
  const failures: string[] = [];
  if (errors.length !== 0) failures.push(`${errors.length} request error(s)`);
  if (gateStats.p50 > P50_BUDGET_MS) failures.push(`gate p50 ${gateStats.p50.toFixed(1)}ms > ${P50_BUDGET_MS}ms`);
  if (gateStats.p99 > P99_BUDGET_MS) failures.push(`gate p99 ${gateStats.p99.toFixed(1)}ms > ${P99_BUDGET_MS}ms`);
  if (!chain.ok) failures.push(`chain broken at seq ${chain.firstBreakSeq ?? "?"}`);

  console.log("");
  if (failures.length === 0) {
    console.log(style.green(`  S20 PASS — 0 errors, gate p50 ${gateStats.p50.toFixed(1)}ms, gate p99 ${gateStats.p99.toFixed(1)}ms, chain intact`));
    console.log(
      style.dim(
        `  (soak spend: ${formatPaise((byVerdict.get("ALLOW") ?? 0) * 20_000)} of ${SOAK_AGENT}'s daily grant)`,
      ),
    );
    return 0;
  }
  console.log(style.red(`  S20 FAIL — ${failures.join("; ")}`));
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof DemoConfigError) {
      console.error(style.red(err.message));
      process.exit(3);
    }
    console.error(err);
    process.exit(1);
  });
