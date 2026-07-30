import { performance } from "node:perf_hooks";
import type { Verdict } from "@mandate/shared";
import {
  MandateClient,
  PolicyDeniedError,
  HoldRejectedError,
  HoldExpiredError,
  MandateError,
  type CheckAction,
  type CheckResponse,
} from "@mandate/sdk";
import { FixtureWorld, createRawTools, type RawTools, type ToolName } from "./tools.js";

/**
 * The agent's authorized tool surface.
 *
 * Each raw tool is wrapped in `guard()` EXACTLY ONCE, here, at construction. Per-call values that
 * `guard()` needs (the acting principal and the model's reasoning) are supplied as thunks reading a
 * mutable turn context, so a single wrapper serves every turn of the conversation.
 *
 * `guard()` deliberately hides the gate's response from the caller (ALLOW just runs, DENY throws).
 * The demo needs to NARRATE the verdict — rule_id, reason, hold id, ledger entry id — so we subclass
 * MandateClient and observe `check()` on the way through. Nothing about the enforcement path changes:
 * the real SDK still makes the call and still decides whether the tool runs.
 */

export type StepOutcome =
  | "EXECUTED" // gate allowed (or an approver released the hold) and the tool ran
  | "DENIED" // gate said DENY — the tool never ran
  | "HELD" // gate said ESCALATE and the hold was still PENDING when the demo stopped waiting
  | "REJECTED" // an approver rejected the hold
  | "EXPIRED" // the hold's TTL elapsed
  | "ERROR"; // transport / tool failure — fail closed, treat as not-done

export interface StepRecord {
  n: number;
  tool: ToolName;
  params: Record<string, unknown>;
  reasoning: string;
  principal: string;
  verdict?: Verdict;
  rule_id?: string;
  reason?: string;
  hold_id?: string;
  ttl_minutes?: number;
  /** VERDICT ledger entry id — the audit anchor for this attempt. */
  entry_id?: string;
  outcome: StepOutcome;
  /** True when the demo itself released the hold (--approve / --reject). */
  decidedByDemo?: "APPROVED" | "REJECTED";
  latencyMs: number;
  result?: unknown;
  error?: string;
  /** Set in --live mode: the Anthropic tool_use block id this step answers. */
  toolUseId?: string;
}

/** Thrown internally when an escalation is still pending after the demo's wait budget. */
class EscalationPendingError extends Error {
  constructor(public readonly hold_id: string) {
    super(`hold ${hold_id} still PENDING`);
    this.name = "EscalationPendingError";
  }
}

/** MandateClient that reports every gate verdict to the session (see the note above). */
class ObservingClient extends MandateClient {
  constructor(
    opts: ConstructorParameters<typeof MandateClient>[0],
    private readonly observe: (res: CheckResponse) => void,
  ) {
    super(opts);
  }

  override async check(action: CheckAction, idempotencyKey?: string): Promise<CheckResponse> {
    const res = await super.check(action, idempotencyKey);
    this.observe(res);
    return res;
  }
}

export interface SessionOptions {
  baseUrl: string;
  /** The acting agent's API key (refunds-agent for the narrative, support-agent for volume). */
  apiKey: string;
  agentId: string;
  /** Admin key — used ONLY to release holds in --approve/--reject mode. */
  adminKey: string;
  conversationRef: string;
  /** Initial acting principal; may be changed per turn with `setPrincipal`. */
  principal: string;
  /** When set, the demo resolves its own escalations so the ESCALATE path completes end to end. */
  autoDecision?: "APPROVED" | "REJECTED";
  /** Principal credited with the auto decision. Must not be the initiating principal (S8). */
  autoDecisionBy?: string;
  /** How long to wait on a PENDING hold before reporting HELD and moving on. */
  escalationWaitMs?: number;
  pollIntervalMs?: number;
  onStep?: (step: StepRecord) => void;
  world?: FixtureWorld;
}

export const DEFAULT_APPROVER = "user:monty@acme.co";

export class GuardedSession {
  readonly world: FixtureWorld;
  readonly raw: RawTools;
  readonly steps: StepRecord[] = [];
  readonly agentId: string;

  private readonly client: ObservingClient;
  private readonly guarded: Record<ToolName, (params: Record<string, unknown>) => Promise<unknown>>;
  private readonly opts: SessionOptions;
  private readonly turn = { principal: "", reasoning: "" };
  private observed: CheckResponse | undefined;

  /**
   * The verdict the gate returned for the step in flight, if one arrived.
   *
   * Read through a method on purpose: `observed` is written from inside the guard's check callback,
   * which TypeScript's control-flow analysis cannot follow, so reading the field directly after
   * clearing it leaves it narrowed to `undefined`. A call's return type is not narrowed.
   */
  private currentObservation(): CheckResponse | undefined {
    return this.observed;
  }

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.agentId = opts.agentId;
    this.turn.principal = opts.principal;
    this.world = opts.world ?? new FixtureWorld();
    this.raw = createRawTools(this.world);

    this.client = new ObservingClient(
      {
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        agentId: opts.agentId,
        pollIntervalMs: opts.pollIntervalMs ?? 300,
      },
      (res) => this.onVerdict(res),
    );

    const guardOpts = {
      principal: () => this.turn.principal,
      reasoning: () => this.turn.reasoning,
      conversationRef: opts.conversationRef,
    };

    // guard() applied once per tool — this object is the agent's ONLY authorized path to a tool.
    this.guarded = {
      lookup_order: this.client.guard("lookup_order", this.raw.lookup_order, guardOpts) as never,
      refund: this.client.guard("refund", this.raw.refund, guardOpts) as never,
      send_email: this.client.guard("send_email", this.raw.send_email, guardOpts) as never,
      update_record: this.client.guard("update_record", this.raw.update_record, guardOpts) as never,
      delete_record: this.client.guard("delete_record", this.raw.delete_record, guardOpts) as never,
      initiate_payout: this.client.guard("initiate_payout", this.raw.initiate_payout, guardOpts) as never,
    };
  }

  setPrincipal(principal: string): void {
    this.turn.principal = principal;
  }

  get principal(): string {
    return this.turn.principal;
  }

  /** Record the verdict for narration, and release the hold ourselves when asked to. */
  private onVerdict(res: CheckResponse): void {
    this.observed = res;
    if (res.verdict === "ESCALATE" && res.hold_id && this.opts.autoDecision) {
      void this.decide(res.hold_id, this.opts.autoDecision);
    }
  }

  /** Release a hold as an approver (admin key). Errors are surfaced on the step, never swallowed. */
  private async decide(holdId: string, decision: "APPROVED" | "REJECTED"): Promise<void> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/v1/holds/${holdId}/decision`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.adminKey}`,
        },
        body: JSON.stringify({
          decision,
          decided_by_principal: this.opts.autoDecisionBy ?? DEFAULT_APPROVER,
          channel: "demo-agent",
        }),
      });
      if (res.status !== 200) {
        this.lastDecisionError = `decision on ${holdId} failed: HTTP ${res.status} ${await res.text()}`;
      }
    } catch (err) {
      this.lastDecisionError = `decision on ${holdId} failed: ${String(err)}`;
    }
  }

  private lastDecisionError: string | undefined;

  /**
   * Call a tool through the gate. Returns the step record; never throws for a policy outcome —
   * a DENY is data the caller (and the model) is supposed to see.
   */
  async call(
    tool: ToolName,
    params: Record<string, unknown>,
    reasoning: string,
  ): Promise<StepRecord> {
    this.turn.reasoning = reasoning;
    this.observed = undefined;
    this.lastDecisionError = undefined;

    const n = this.steps.length + 1;
    const started = performance.now();
    const budgetMs = this.opts.escalationWaitMs ?? (this.opts.autoDecision ? 20_000 : 10_000);

    let outcome: StepOutcome = "ERROR";
    let result: unknown;
    let error: string | undefined;

    try {
      result = await raceBudget(this.guarded[tool](params), budgetMs, () => this.observed?.hold_id);
      outcome = "EXECUTED";
    } catch (err) {
      if (err instanceof PolicyDeniedError) outcome = "DENIED";
      else if (err instanceof HoldRejectedError) outcome = "REJECTED";
      else if (err instanceof HoldExpiredError) outcome = "EXPIRED";
      else if (err instanceof EscalationPendingError) outcome = "HELD";
      else outcome = "ERROR";
      error = err instanceof Error ? err.message : String(err);
      if (err instanceof MandateError && outcome === "ERROR" && err.status !== undefined) {
        error = `${error} (HTTP ${err.status})`;
      }
    }

    const step: StepRecord = {
      n,
      tool,
      params,
      reasoning,
      principal: this.turn.principal,
      outcome,
      latencyMs: Math.round(performance.now() - started),
    };
    const seen = this.currentObservation();
    if (seen) {
      step.verdict = seen.verdict;
      step.rule_id = seen.rule_id;
      step.entry_id = seen.entry_id;
      if (seen.reason) step.reason = seen.reason;
      if (seen.hold_id) step.hold_id = seen.hold_id;
      if (seen.ttl_minutes !== undefined) step.ttl_minutes = seen.ttl_minutes;
    }
    if (this.opts.autoDecision && seen?.verdict === "ESCALATE") {
      step.decidedByDemo = this.opts.autoDecision;
    }
    if (result !== undefined) step.result = result;
    if (error) step.error = error;
    if (this.lastDecisionError) {
      step.error = step.error ? `${step.error}; ${this.lastDecisionError}` : this.lastDecisionError;
    }

    this.steps.push(step);
    this.opts.onStep?.(step);
    return step;
  }

  /** Steps whose tool actually ran. */
  get executed(): StepRecord[] {
    return this.steps.filter((s) => s.outcome === "EXECUTED");
  }

  /** Steps the gate stopped (DENY / held / rejected / expired). */
  get blocked(): StepRecord[] {
    return this.steps.filter((s) => s.outcome !== "EXECUTED");
  }
}

/**
 * Give a guarded call a wall-clock budget. An escalation whose approver never answers would
 * otherwise block for the hold's whole TTL (up to 4 hours) — the demo reports HELD and moves on.
 * The underlying poll keeps running; the CLI exits explicitly when the run is done.
 */
function raceBudget<T>(work: Promise<T>, budgetMs: number, holdId: () => string | undefined): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bail = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const id = holdId();
      reject(
        id
          ? new EscalationPendingError(id)
          : new Error(`tool call did not settle within ${budgetMs}ms`),
      );
    }, budgetMs);
  });
  return Promise.race([work, bail]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
