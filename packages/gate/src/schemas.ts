import { z } from "zod";

/** Single-tenant POC: every admin query defaults to the seeded tenant. */
export const DEFAULT_TENANT = "acme-fintech";

/** POST /v1/actions/check body (API.md). `amount`, when present, must be an integer (paise, D13). */
export const checkBodySchema = z
  .object({
    tool: z.string().min(1),
    params: z.record(z.unknown()),
    principal: z.string().min(1),
    context: z
      .object({
        reasoning: z.string().optional(),
        conversation_ref: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    const amt = (val.params as Record<string, unknown>).amount;
    if (amt !== undefined && !(typeof amt === "number" && Number.isInteger(amt))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "amount"],
        message: "amount must be an integer in minor units (paise)",
      });
    }
  });

export type CheckBody = z.infer<typeof checkBodySchema>;

/** POST /v1/actions/:entry_id/result body (API.md). */
export const resultBodySchema = z.object({
  status: z.enum(["SUCCESS", "FAILURE"]),
  result_hash: z.string().min(1),
});

export type ResultBody = z.infer<typeof resultBodySchema>;

/** POST /v1/policies body (API.md). */
export const policyCreateSchema = z.object({
  yaml: z.string().min(1),
});

export type PolicyCreateBody = z.infer<typeof policyCreateSchema>;

/** POST /v1/holds/:hold_id/decision body (API.md). */
export const decisionBodySchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  decided_by_principal: z.string().min(1),
  channel: z.string().min(1).default("telegram"),
});

export type DecisionBody = z.infer<typeof decisionBodySchema>;

const isoDate = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO 8601 timestamp" });

/**
 * POST /v1/agents body — chartering an agent (§5.1). owner_principal, department and expires_at are
 * REQUIRED: an agent with no accountable human or no end date is exactly what Charter exists to stop.
 */
export const registerAgentSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lower-kebab-case"),
  name: z.string().min(1),
  owner_principal: z.string().min(1),
  department: z.string().min(1),
  purpose: z.string().optional(),
  approver_chain: z.array(z.string().min(1)).default([]),
  expires_at: isoDate,
  max_autonomy: z.enum(["ALLOW", "ESCALATE"]).default("ALLOW"),
});

export type RegisterAgentBody = z.infer<typeof registerAgentSchema>;

/** POST /v1/agents/:agent_id/authorities body — issuing a grant (§5.2). */
export const grantAuthoritySchema = z
  .object({
    grantor_principal: z.string().min(1),
    valid_from: isoDate,
    valid_until: isoDate,
    budget_minor: z.number().int().nonnegative().nullable().default(null),
    budget_currency: z.string().length(3).default("INR"),
    budget_window_minutes: z.number().int().positive().default(1440),
    allowed_tools: z.array(z.string().min(1)).default([]),
    forbidden_ops: z.array(z.string().min(1)).default([]),
    ref: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (Date.parse(val.valid_until) <= Date.parse(val.valid_from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["valid_until"],
        message: "valid_until must be after valid_from",
      });
    }
    const overlap = val.allowed_tools.filter((t) => val.forbidden_ops.includes(t));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forbidden_ops"],
        message: `a tool cannot be both allowed and forbidden: ${overlap.join(", ")}`,
      });
    }
  });

export type GrantAuthorityBody = z.infer<typeof grantAuthoritySchema>;

/**
 * GET /v1/attestation query (Charter §5.5). `from`/`to` are validated here so a typo can never be
 * silently coerced into a window that quietly excludes evidence; both default to a
 * Postgres-resolved last-30-days when omitted.
 */
export const attestationQuerySchema = z
  .object({
    tenant: z.string().min(1).default(DEFAULT_TENANT),
    from: isoDate.optional(),
    to: isoDate.optional(),
    agent_id: z.string().min(1).optional(),
    format: z.enum(["json", "html"]).default("json"),
  })
  .superRefine((val, ctx) => {
    if (val.from && val.to && Date.parse(val.to) <= Date.parse(val.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to must be after from",
      });
    }
  });

export type AttestationQuery = z.infer<typeof attestationQuerySchema>;

/**
 * GET /v1/stream query. `from_seq` is INCLUSIVE (same convention as GET /v1/ledger); omitted means
 * "only entries recorded from now on".
 */
export const streamQuerySchema = z.object({
  tenant: z.string().min(1).default(DEFAULT_TENANT),
  from_seq: z.coerce.number().int().nonnegative().optional(),
});

export type StreamQuery = z.infer<typeof streamQuerySchema>;

/** POST /v1/authorities/:id/revoke and POST /v1/agents/:id/reinstate body. */
export const revokeSchema = z.object({
  by_principal: z.string().min(1),
  reason: z.string().optional(),
});

export type RevokeBody = z.infer<typeof revokeSchema>;
