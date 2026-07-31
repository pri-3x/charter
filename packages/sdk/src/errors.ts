/** Errors thrown by the SDK (SPEC §7 / DECISIONS D14). */

export class CharterError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "CharterError";
  }
}

/** Thrown when the gate returns verdict DENY. */
export class PolicyDeniedError extends CharterError {
  constructor(
    public rule_id: string,
    public reason: string | undefined,
    public entry_id: string,
  ) {
    super(`policy denied (${rule_id})${reason ? ": " + reason : ""}`);
    this.name = "PolicyDeniedError";
  }
}

/** Thrown when an escalation is rejected by an approver. */
export class HoldRejectedError extends CharterError {
  constructor(public hold_id: string) {
    super(`hold ${hold_id} was rejected`);
    this.name = "HoldRejectedError";
  }
}

/** Thrown when an escalation expires (TTL elapsed) — fail closed, the action does not run. */
export class HoldExpiredError extends CharterError {
  constructor(public hold_id: string) {
    super(`hold ${hold_id} expired before a decision`);
    this.name = "HoldExpiredError";
  }
}
