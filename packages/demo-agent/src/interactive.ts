import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { agentSays, heading, note, printLedgerSummary, printStep, section, style, warn } from "./narrative.js";
import { formatPaise } from "./money.js";
import { CUSTOMERS, ORDERS, customer, emailOf, principalOf } from "./fixtures.js";
import { GuardedSession } from "./session.js";
import { agentKey, type DemoConfig } from "./config.js";
import { DEFAULT_SYSTEM_PROMPT, requireLiveKey, runLive } from "./live.js";
import type { ToolName } from "./tools.js";

/**
 * `--interactive`: a small REPL for driving the guarded tools by hand. Every command goes through the
 * same `GuardedSession`, so the gate sees exactly what it sees in the scripted scenarios.
 */

const HELP = `
commands
  lookup <ORD-id>                       read an order
  refund <ORD-id> <paise> [reason...]   refund (integer paise! Rs 200 = 20000)
  email <subject> | <body>              email the current customer
  update <field> <value>                set a field on the customer record
  delete                                attempt to delete the customer record (policy says no)
  payout <beneficiary> <paise>          attempt a payout (the grant says no)
  why <text>                            set the reasoning sent with the NEXT call
  as <customer-key>                     switch customer (${CUSTOMERS.map((c) => c.key).join(", ")})
  agent <agent-id>                      switch acting agent (rebuilds the session)
  say <text>                            (--live only) hand the turn to the model
  who                                   show the current agent, customer and principal
  orders                                list fixture orders
  steps                                 summary of everything attempted so far
  help                                  this message
  quit                                  exit
`.trimStart();

export interface InteractiveOptions {
  config: DemoConfig;
  runTag: string;
  live: boolean;
  decision?: "APPROVED" | "REJECTED";
  agentId?: string;
  verbose?: boolean;
}

export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  let agentId = opts.agentId ?? "refunds-agent";
  let current = customer("priya");
  let pendingReasoning: string | undefined;

  const build = (): GuardedSession => {
    const base = {
      baseUrl: opts.config.baseUrl,
      apiKey: agentKey(opts.config.seed, agentId),
      agentId,
      adminKey: opts.config.seed.adminKey,
      conversationRef: `demo/interactive/${opts.runTag}`,
      principal: principalOf(current, opts.runTag),
      onStep: printStep,
    };
    return new GuardedSession(opts.decision ? { ...base, autoDecision: opts.decision } : base);
  };

  let session = build();

  heading("interactive mode", `gate=${opts.config.baseUrl} run-tag=${opts.runTag}`);
  note(`acting agent: ${agentId} · customer: ${current.name} (${session.principal})`);
  if (opts.live) note(`live model available: ${opts.config.model} — use \`say <text>\``);
  console.log(HELP);

  const rl = createInterface({ input: stdin, output: stdout });
  const all: GuardedSession[] = [session];

  const callTool = async (tool: ToolName, params: Record<string, unknown>, fallbackReasoning: string): Promise<void> => {
    const reasoning = pendingReasoning ?? fallbackReasoning;
    pendingReasoning = undefined;
    await session.call(tool, params, reasoning);
  };

  try {
    for (;;) {
      const line = (await rl.question(style.bold(`${agentId} > `))).trim();
      if (line === "") continue;
      const [cmd, ...rest] = line.split(/\s+/);
      const argline = rest.join(" ");

      try {
        switch (cmd) {
          case "quit":
          case "exit":
            return 0;
          case "help":
            console.log(HELP);
            break;
          case "who":
            note(`agent=${agentId} customer=${current.name} principal=${session.principal}`);
            break;
          case "orders":
            for (const o of ORDERS) {
              console.log(`  ${o.id}  ${formatPaise(o.totalMinor).padStart(14)}  ${o.status.padEnd(10)} ${o.item}`);
            }
            break;
          case "steps":
            printLedgerSummary(all.flatMap((s) => s.steps));
            break;
          case "why":
            if (!argline) throw new Error("why needs text");
            pendingReasoning = argline;
            note(`next call will carry reasoning: "${argline}"`);
            break;
          case "as": {
            const c = CUSTOMERS.find((x) => x.key === rest[0]);
            if (!c) throw new Error(`unknown customer '${rest[0] ?? ""}'`);
            current = c;
            session.setPrincipal(principalOf(current, opts.runTag));
            note(`customer is now ${current.name} (${session.principal})`);
            break;
          }
          case "agent": {
            const id = rest[0];
            if (!id) throw new Error("agent needs an id");
            agentKey(opts.config.seed, id); // throws if unknown — fail before swapping
            agentId = id;
            session = build();
            all.push(session);
            note(`acting agent is now ${agentId}`);
            break;
          }
          case "lookup": {
            const id = rest[0];
            if (!id) throw new Error("lookup needs an order id");
            await callTool("lookup_order", { order_id: id }, `Operator asked to read ${id}.`);
            break;
          }
          case "refund": {
            const [id, amountRaw, ...reasonParts] = rest;
            if (!id || !amountRaw) throw new Error("usage: refund <ORD-id> <paise> [reason...]");
            const amount = Number(amountRaw);
            if (!Number.isInteger(amount) || amount <= 0) {
              throw new Error(`amount must be a positive integer in paise, got '${amountRaw}'`);
            }
            const reason = reasonParts.join(" ") || "Operator-initiated refund";
            await callTool(
              "refund",
              { order_id: id, amount, currency: "INR", reason },
              `Operator-initiated refund of ${formatPaise(amount)} on ${id}: ${reason}`,
            );
            break;
          }
          case "email": {
            const [subject, body] = argline.split("|").map((s) => s.trim());
            if (!subject) throw new Error("usage: email <subject> | <body>");
            await callTool(
              "send_email",
              { to: emailOf(current, opts.runTag), subject, body: body || subject },
              `Emailing ${current.name} about: ${subject}`,
            );
            break;
          }
          case "update": {
            const [field, ...valueParts] = rest;
            const value = valueParts.join(" ");
            if (!field || !value) throw new Error("usage: update <field> <value>");
            await callTool(
              "update_record",
              { record_type: "customer", record_id: current.recordId, field, value },
              `Setting ${field}=${value} on ${current.recordId}.`,
            );
            break;
          }
          case "delete":
            await callTool(
              "delete_record",
              { record_type: "customer", record_id: current.recordId },
              `Attempting to delete ${current.recordId} on the operator's instruction.`,
            );
            break;
          case "payout": {
            const [beneficiary, amountRaw] = rest;
            if (!beneficiary || !amountRaw) throw new Error("usage: payout <beneficiary> <paise>");
            const amount = Number(amountRaw);
            if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be integer paise");
            await callTool(
              "initiate_payout",
              { beneficiary, amount, currency: "INR" },
              `Attempting a ${formatPaise(amount)} payout to ${beneficiary}.`,
            );
            break;
          }
          case "say": {
            if (!opts.live) {
              warn("`say` needs --live (and ANTHROPIC_API_KEY). Use the direct tool commands instead.");
              break;
            }
            if (!argline) throw new Error("say needs text");
            const apiKey = requireLiveKey(opts.config.anthropicApiKey);
            const result = await runLive({
              session,
              model: opts.config.model,
              apiKey,
              systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nThe customer you are talking to is ${session.principal}.`,
              customerTurns: [argline],
              ...(opts.verbose ? { verbose: true } : {}),
            });
            const reply = result.replies[result.replies.length - 1];
            if (reply) agentSays(reply);
            break;
          }
          default:
            warn(`unknown command '${cmd}' — try help`);
        }
      } catch (err) {
        warn(err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    rl.close();
    section("session summary");
    printLedgerSummary(all.flatMap((s) => s.steps));
  }
}
