import { SCENARIO_IDS, isScenarioId, type ScenarioId, ADVERSARIAL_IDS } from "./scenarios.js";

/** CLI argument parsing, kept pure so it is unit-testable without touching the gate. */

export interface ParsedArgs {
  mode: "scenarios" | "interactive" | "help";
  scenarios: ScenarioId[];
  live: boolean;
  decision?: "APPROVED" | "REJECTED";
  verbose: boolean;
  runTag?: string;
  agentId?: string;
}

export class ArgError extends Error {}

export const USAGE = `
charter demo agent — a customer-support agent whose every tool call is authorized by the gate

  npm run demo:agent -- [options]
  npm run adversarial                 # shorthand for --scenario A1,A2,A3,A4

Options
  --scenario <ids>   Comma-separated scenario ids: ${SCENARIO_IDS.join(", ")}
  --all              Run every scenario in order
  --adversarial      Run the adversarial suite (${ADVERSARIAL_IDS.join(", ")})
  --interactive      REPL: drive the guarded tools by hand
  --live             Use a real Anthropic tool-use loop (requires ANTHROPIC_API_KEY).
                     Default is the deterministic fixture model, which needs no API key.
  --approve          Release escalations from inside the demo, as an approver (completes S3/S5)
  --reject           Reject escalations from inside the demo
  --agent <id>       Acting agent for --interactive (default refunds-agent)
  --run-tag <tag>    Override the run tag baked into fixture principals
  --verbose          Stream the live model's text as it arrives
  -h, --help         This message

Environment
  CHARTER_BASE_URL   Gate base URL (default http://127.0.0.1:$PORT, PORT default 8080)
  ANTHROPIC_API_KEY  Required for --live only
  ANTHROPIC_MODEL    Model id for --live (default claude-sonnet-4-6)
`.trimStart();

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { mode: "scenarios", scenarios: [], live: false, verbose: false };
  const requested: ScenarioId[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return { ...out, mode: "help" };
      case "--live":
        out.live = true;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--interactive":
        out.mode = "interactive";
        break;
      case "--approve":
        if (out.decision === "REJECTED") throw new ArgError("--approve and --reject are mutually exclusive");
        out.decision = "APPROVED";
        break;
      case "--reject":
        if (out.decision === "APPROVED") throw new ArgError("--approve and --reject are mutually exclusive");
        out.decision = "REJECTED";
        break;
      case "--all":
        requested.push(...SCENARIO_IDS);
        break;
      case "--adversarial":
        requested.push(...ADVERSARIAL_IDS);
        break;
      case "--scenario": {
        const value = argv[++i];
        if (!value) throw new ArgError("--scenario needs a value, e.g. --scenario S1,A2");
        for (const raw of value.split(",")) {
          const id = raw.trim().toUpperCase();
          if (id === "") continue;
          if (!isScenarioId(id)) {
            throw new ArgError(`unknown scenario '${raw.trim()}'. Known ids: ${SCENARIO_IDS.join(", ")}`);
          }
          requested.push(id);
        }
        break;
      }
      case "--agent": {
        const value = argv[++i];
        if (!value) throw new ArgError("--agent needs an agent id");
        out.agentId = value;
        break;
      }
      case "--run-tag": {
        const value = argv[++i];
        if (!value) throw new ArgError("--run-tag needs a value");
        if (!/^[a-z0-9]{2,16}$/.test(value)) {
          throw new ArgError("--run-tag must be 2-16 lowercase alphanumeric characters");
        }
        out.runTag = value;
        break;
      }
      default:
        throw new ArgError(`unknown option '${arg}' (try --help)`);
    }
  }

  // De-duplicate while keeping the requested order.
  out.scenarios = requested.filter((id, idx) => requested.indexOf(id) === idx);
  if (out.mode === "scenarios" && out.scenarios.length === 0) {
    out.scenarios = [...SCENARIO_IDS];
  }
  return out;
}
