import { ArgError, USAGE, parseArgs } from "./args.js";
import { DemoConfigError, loadDemoConfig, requireHealthyGate } from "./config.js";
import { newRunTag } from "./fixtures.js";
import { LiveModeUnavailableError } from "./live.js";
import { fail, heading, note, style, warn } from "./narrative.js";
import { checkChainSince, runScenarios } from "./scenarios.js";
import { LedgerReader } from "./ledger.js";
import { runInteractive } from "./interactive.js";

/**
 * `npm run demo:agent -- [options]`.
 *
 * Exits non-zero on any failed assertion, an unreachable gate, or --live without an API key.
 * The process is ended explicitly: a still-PENDING escalation leaves the SDK polling its hold in the
 * background (up to the hold's TTL), and the demo should not appear to hang because of it.
 */
async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      fail(err.message);
      console.log("");
      console.log(USAGE);
      return 2;
    }
    throw err;
  }

  if (args.mode === "help") {
    console.log(USAGE);
    return 0;
  }

  const config = loadDemoConfig();
  if (args.live && !config.anthropicApiKey) {
    fail(
      "--live requires ANTHROPIC_API_KEY. Set it in .env or the environment, or drop --live to run " +
        "the deterministic fixture model (no API key needed). Not falling back silently.",
    );
    return 3;
  }

  const health = await requireHealthyGate(config.baseUrl);
  const runTag = args.runTag ?? newRunTag();

  heading(
    "Charter demo agent",
    `gate=${config.baseUrl} · active policy v${health.activePolicyVersion ?? "?"} · ` +
      `model=${args.live ? config.model + " (live)" : "fixture (deterministic)"} · run-tag=${runTag}`,
  );
  note(
    "Fixture principals are run-scoped (…+" +
      runTag +
      "@example.com) so the 24-hour velocity limit cannot leak between runs.",
  );
  if (args.decision) {
    note(`escalations will be released from inside the demo as ${args.decision} by an approver.`);
  }

  if (args.mode === "interactive") {
    return runInteractive({
      config,
      runTag,
      live: args.live,
      ...(args.decision ? { decision: args.decision } : {}),
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.verbose ? { verbose: true } : {}),
    });
  }

  const reader = new LedgerReader({
    baseUrl: config.baseUrl,
    adminKey: config.seed.adminKey,
    tenant: config.seed.tenant,
  });
  const startSeq = await reader.headSeq();

  const driverOptions = {
    config,
    live: args.live,
    runTag,
    verbose: args.verbose,
    ...(args.decision ? { decision: args.decision } : {}),
  };
  const results = await runScenarios(args.scenarios, driverOptions);
  await checkChainSince(driverOptions, startSeq + 1);

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) return 1;

  const held = results.flatMap((r) => r.steps).filter((s) => s.outcome === "HELD");
  if (held.length > 0) {
    warn(
      `${held.length} escalation(s) are still PENDING (${held.map((h) => h.hold_id).join(", ")}). ` +
        `Approve them in the console, or re-run with --approve.`,
    );
  }
  return 0;
}

main()
  .then((code) => {
    // Explicit exit: see the note at the top of this file.
    process.exit(code);
  })
  .catch((err: unknown) => {
    if (err instanceof DemoConfigError || err instanceof LiveModeUnavailableError) {
      fail(err.message);
      process.exit(3);
    }
    console.error(style.red("demo agent crashed:"), err);
    process.exit(1);
  });
