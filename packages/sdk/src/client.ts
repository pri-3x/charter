import { randomUUID } from "node:crypto";
import { jcsHashToken } from "@charter/shared";
import type { Verdict } from "@charter/shared";
import { CharterError, PolicyDeniedError, HoldRejectedError, HoldExpiredError } from "./errors.js";

export interface CharterClientOptions {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  /** Poll interval for escalations (SPEC §7 default 2s). Lower it in tests. */
  pollIntervalMs?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export interface CheckAction {
  tool: string;
  params: Record<string, unknown>;
  principal: string;
  context?: { reasoning?: string; conversation_ref?: string };
}

export interface CheckResponse {
  verdict: Verdict;
  entry_id: string;
  rule_id: string;
  reason?: string;
  hold_id?: string;
  ttl_minutes?: number;
}

export interface HoldView {
  hold_id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  decided_by: string | null;
  decided_at: string | null;
  verdict_entry_id: string;
}

export interface GuardOptions {
  principal: string | (() => string);
  reasoning?: string | (() => string);
  conversationRef?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class CharterClient {
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CharterClientOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return this.opts.baseUrl.replace(/\/$/, "") + path;
  }

  /** Low-level check. Throws CharterError on 5xx / malformed (fail closed — caller must not run). */
  async check(action: CheckAction, idempotencyKey?: string): Promise<CheckResponse> {
    const res = await this.fetchImpl(this.url("/v1/actions/check"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Idempotency-Key": idempotencyKey ?? randomUUID(),
      },
      body: JSON.stringify(action),
    });
    if (res.status !== 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new CharterError(`check failed with HTTP ${res.status}`, res.status, body);
    }
    return (await res.json()) as CheckResponse;
  }

  /** Report the outcome of an executed action → OUTCOME ledger entry. */
  async reportResult(
    entryId: string,
    outcome: { status: "SUCCESS" | "FAILURE"; result_hash: string },
  ): Promise<{ outcome_entry_id: string }> {
    const res = await this.fetchImpl(this.url(`/v1/actions/${entryId}/result`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(outcome),
    });
    if (res.status !== 200) {
      throw new CharterError(`reportResult failed with HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as { outcome_entry_id: string };
  }

  async getHold(holdId: string): Promise<HoldView> {
    const res = await this.fetchImpl(this.url(`/v1/holds/${holdId}`), {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (res.status !== 200) {
      throw new CharterError(`getHold failed with HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as HoldView;
  }

  /** Best-effort OUTCOME report — never let a reporting failure mask the action's own result. */
  private async reportSafe(
    entryId: string,
    status: "SUCCESS" | "FAILURE",
    result: unknown,
  ): Promise<void> {
    try {
      await this.reportResult(entryId, { status, result_hash: jcsHashToken(result ?? null) });
    } catch {
      /* swallow: the verdict + hold are already durably recorded */
    }
  }

  /**
   * Wrap a real tool function so every call is authorized by the gate first (SPEC §7).
   *   ALLOW    → run fn, report SUCCESS/FAILURE, return the result
   *   DENY     → throw PolicyDeniedError (fn never runs)
   *   ESCALATE → poll the hold until APPROVED (run fn) / REJECTED / EXPIRED (throw)
   */
  guard<A extends Record<string, unknown>, R>(
    tool: string,
    fn: (params: A) => Promise<R> | R,
    opts: GuardOptions,
  ): (params: A) => Promise<R> {
    return async (params: A): Promise<R> => {
      const principal = typeof opts.principal === "function" ? opts.principal() : opts.principal;
      const reasoning =
        typeof opts.reasoning === "function" ? opts.reasoning() : opts.reasoning;
      const action: CheckAction = { tool, params, principal };
      if (reasoning || opts.conversationRef) {
        action.context = {};
        if (reasoning) action.context.reasoning = reasoning;
        if (opts.conversationRef) action.context.conversation_ref = opts.conversationRef;
      }

      const verdict = await this.check(action);

      if (verdict.verdict === "DENY") {
        throw new PolicyDeniedError(verdict.rule_id, verdict.reason, verdict.entry_id);
      }

      if (verdict.verdict === "ESCALATE") {
        await this.awaitHold(verdict);
      }

      return this.runAndReport(fn, params, verdict.entry_id);
    };
  }

  private async runAndReport<A, R>(
    fn: (params: A) => Promise<R> | R,
    params: A,
    entryId: string,
  ): Promise<R> {
    let out: R;
    try {
      out = await fn(params);
    } catch (err) {
      await this.reportSafe(entryId, "FAILURE", { error: String(err) });
      throw err;
    }
    await this.reportSafe(entryId, "SUCCESS", out);
    return out;
  }

  /** Poll the hold until it leaves PENDING; throw on REJECTED / EXPIRED. */
  private async awaitHold(verdict: CheckResponse): Promise<void> {
    const holdId = verdict.hold_id!;
    const ttlMs = (verdict.ttl_minutes ?? 240) * 60_000;
    const deadline = Date.now() + ttlMs + 5_000; // safety cap; the sweeper resolves at TTL
    for (;;) {
      await sleep(this.pollIntervalMs);
      const hold = await this.getHold(holdId);
      if (hold.status === "APPROVED") return;
      if (hold.status === "REJECTED") throw new HoldRejectedError(holdId);
      if (hold.status === "EXPIRED") throw new HoldExpiredError(holdId);
      if (Date.now() > deadline) throw new HoldExpiredError(holdId);
    }
  }
}
