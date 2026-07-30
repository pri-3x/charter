import type { PoolClient } from "../db.js";
import type { LimitMatch, Usage, ConsumeItem } from "./evaluate.js";

/**
 * Stateful limits over `limit_counters` (D8). Both the usage read and the consumption write happen
 * inside the verdict transaction so a limit decision and its counter increment commit atomically.
 * Windows use 1-minute buckets; current usage sums the buckets within the rule's window.
 */

/** Read current window usage for each matched limit rule (keyed by rule id). */
export async function fetchUsages(
  client: PoolClient,
  tenant: string,
  matches: LimitMatch[],
): Promise<Map<string, Usage>> {
  const usages = new Map<string, Usage>();
  for (const m of matches) {
    const windowMinutes = m.rule.limit!.window_minutes;
    const { rows } = await client.query<{ c: string; s: string }>(
      `SELECT COALESCE(SUM(event_count), 0)::bigint AS c,
              COALESCE(SUM(event_sum), 0)::bigint AS s
         FROM limit_counters
        WHERE tenant_id = $1 AND rule_id = $2 AND key = $3
          AND window_start > now() - make_interval(mins => $4)`,
      [tenant, m.rule.id, m.key, windowMinutes],
    );
    usages.set(m.rule.id, { count: Number(rows[0]!.c), sum: Number(rows[0]!.s) });
  }
  return usages;
}

/** Apply counter increments for an ALLOW verdict, into the current 1-minute bucket. */
export async function applyConsumption(
  client: PoolClient,
  tenant: string,
  consume: ConsumeItem[],
): Promise<void> {
  for (const c of consume) {
    const countInc = 1;
    const sumInc = c.kind === "sum" ? c.value : 0;
    await client.query(
      `INSERT INTO limit_counters (tenant_id, rule_id, key, window_start, event_count, event_sum)
       VALUES ($1, $2, $3, date_trunc('minute', now()), $4, $5)
       ON CONFLICT (tenant_id, rule_id, key, window_start)
       DO UPDATE SET event_count = limit_counters.event_count + EXCLUDED.event_count,
                     event_sum   = limit_counters.event_sum   + EXCLUDED.event_sum`,
      [tenant, c.rule_id, c.key, countInc, sumInc],
    );
  }
}
