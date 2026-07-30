import { z } from "zod";
import { parse as parseYaml } from "yaml";

/**
 * Policy document schema (SPEC 3.1). Parsed from YAML, validated with zod. The `version` in the
 * document is advisory only — the server assigns the real version on activation (D11).
 */

const verdictEnum = z.enum(["ALLOW", "DENY", "ESCALATE"]);

/** A `when` field matcher: a bare scalar (eq shorthand) or an operator object (SPEC 3.2). */
const matcherSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z
    .object({
      eq: z.union([z.string(), z.number(), z.boolean()]).optional(),
      gt: z.number().optional(),
      gte: z.number().optional(),
      lt: z.number().optional(),
      lte: z.number().optional(),
      in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .strict()
    .refine((o) => Object.keys(o).length > 0, "matcher must have at least one operator"),
]);

const limitSchema = z
  .object({
    window_minutes: z.number().int().positive(),
    max_count: z.number().int().positive().optional(),
    sum_param: z.string().optional(),
    max_sum: z.number().int().positive().optional(),
    key: z.enum(["agent", "principal"]),
  })
  .strict()
  .refine(
    (l) => (l.max_count !== undefined) !== (l.sum_param !== undefined),
    "limit must be either a count limit (max_count) or a sum limit (sum_param + max_sum), not both",
  )
  .refine(
    (l) => l.sum_param === undefined || l.max_sum !== undefined,
    "a sum limit requires max_sum",
  );

export const ruleSchema = z
  .object({
    id: z.string().min(1),
    when: z.record(matcherSchema),
    verdict: verdictEnum.optional(),
    reason: z.string().optional(),
    approvers: z.array(z.string()).optional(),
    ttl_minutes: z.number().int().positive().optional(),
    limit: limitSchema.optional(),
    verdict_on_breach: verdictEnum.optional(),
  })
  .strict()
  .refine(
    (r) => r.verdict !== undefined || r.limit !== undefined,
    "a rule must have a verdict or a limit",
  )
  .refine(
    (r) => r.limit === undefined || r.verdict_on_breach !== undefined,
    "a limit rule must specify verdict_on_breach",
  );

export const policySchema = z
  .object({
    version: z.number().int().optional(),
    tenant: z.string().min(1),
    defaults: z
      .object({
        unknown_tool: verdictEnum,
        unknown_agent: verdictEnum,
      })
      .strict(),
    agents: z.record(
      z
        .object({
          allowed_tools: z.array(z.string()),
          max_autonomy: z.enum(["ALLOW", "ESCALATE"]),
        })
        .strict(),
    ),
    rules: z.array(ruleSchema),
  })
  .strict();

export type Matcher = z.infer<typeof matcherSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type PolicyDoc = z.infer<typeof policySchema>;

export interface ParsedPolicy {
  doc: PolicyDoc;
}

/** Parse + validate a YAML policy document. Throws a descriptive error on malformed input. */
export function parsePolicyYaml(yamlText: string): PolicyDoc {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`policy YAML is not valid YAML: ${(err as Error).message}`);
  }
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    throw new PolicyValidationError(result.error.issues);
  }
  return result.data;
}

export class PolicyValidationError extends Error {
  constructor(public issues: z.ZodIssue[]) {
    super("policy validation failed");
    this.name = "PolicyValidationError";
  }
}
