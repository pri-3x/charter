import { Bot, InlineKeyboard } from "grammy";
import pg from "pg";
import { loadEnv } from "@charter/shared";

/**
 * Telegram approvals bot (SPEC §6, M3). Long-polls Telegram; separately polls the DB every 2s for
 * new PENDING holds and sends a context packet with inline Approve/Reject buttons. Button taps map
 * the Telegram user → a principal and call the gate's decision endpoint (which enforces the
 * self-approval 403). The 30s TTL expiry sweeper lives in the gate process (it writes ledger
 * entries); this bot only notifies + relays decisions.
 *
 * Manual check only (needs a real bot token + chat) — not part of the automated scenario suite.
 */

loadEnv();

const { Pool } = pg;
const HOLD_POLL_MS = 2000;

interface HoldPacket {
  id: string;
  verdict_entry_id: string;
  initiating_principal: string;
  payload: {
    action?: { tool?: string; params?: Record<string, unknown> };
    context?: { reasoning?: string };
    rule_id?: string;
    reason?: string;
    agent?: { id?: string };
  };
  approver_chat: string | null;
}

function formatAmount(params: Record<string, unknown> | undefined): string {
  if (!params || typeof params.amount !== "number") return "";
  const rupees = (params.amount / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return ` · ₹${rupees}`;
}

async function velocityReadout(
  pool: pg.Pool,
  tenant: string,
  principal: string,
): Promise<string> {
  // R5: refund sum per principal over 24h vs 5,000,000 paise (mirrors example.acme.yaml).
  const { rows } = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(event_sum),0)::bigint AS s FROM limit_counters
      WHERE tenant_id=$1 AND rule_id='R5-refund-velocity' AND key=$2
        AND window_start > now() - make_interval(mins => 1440)`,
    [tenant, `principal:${principal}`],
  );
  const used = Number(rows[0]?.s ?? 0) / 100;
  return `refund velocity today: ₹${used.toLocaleString("en-IN")} of ₹50,000`;
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[approvals] TELEGRAM_BOT_TOKEN not set — approvals bot idle (set it to enable).");
    return;
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  const adminKey = process.env.CHARTER_ADMIN_KEY;
  if (!adminKey) throw new Error("CHARTER_ADMIN_KEY is required");
  const gateBase = process.env.GATE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;

  const pool = new Pool({ connectionString: dbUrl });
  const bot = new Bot(token);

  // ---- button callbacks: map telegram user → principal, relay to the decision endpoint ----
  bot.callbackQuery(/^(a|r):(.+)$/, async (ctx) => {
    const [, action, holdId] = ctx.match!;
    const tgUserId = ctx.from?.id;
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM principals WHERE telegram_user_id = $1",
      [tgUserId],
    );
    const principal = rows[0]?.id;
    if (!principal) {
      await ctx.answerCallbackQuery({ text: "You are not a mapped approver.", show_alert: true });
      return;
    }
    const decision = action === "a" ? "APPROVED" : "REJECTED";
    const res = await fetch(`${gateBase}/v1/holds/${holdId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminKey}` },
      body: JSON.stringify({ decision, decided_by_principal: principal, channel: "telegram" }),
    });
    if (res.status === 403) {
      await ctx.answerCallbackQuery({ text: "You can't decide your own request.", show_alert: true });
      return;
    }
    if (res.status === 409) {
      await ctx.answerCallbackQuery({ text: "Already resolved.", show_alert: true });
      return;
    }
    if (res.status !== 200) {
      await ctx.answerCallbackQuery({ text: `Error ${res.status}`, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: decision });
    const verb = decision === "APPROVED" ? "✅ APPROVED" : "⛔ REJECTED";
    await ctx.editMessageText(`${ctx.msg?.text ?? "hold"}\n\n${verb} by ${principal}`, {
      reply_markup: undefined,
    });
  });

  void bot.start();
  console.log("[approvals] bot started (long polling)");

  // ---- notifier: send a packet for each un-notified PENDING hold ----
  async function notifyNewHolds(): Promise<void> {
    const { rows } = await pool.query<HoldPacket>(
      `SELECT h.id, h.verdict_entry_id, h.initiating_principal, e.payload, t.approver_chat
         FROM holds h
         JOIN ledger_entries e ON e.entry_id = h.verdict_entry_id AND e.tenant_id = h.tenant_id
         JOIN tenants t ON t.id = h.tenant_id
        WHERE h.status = 'PENDING' AND h.telegram_message IS NULL
        ORDER BY h.created_at ASC`,
    );
    for (const hold of rows) {
      if (!hold.approver_chat) continue;
      const p = hold.payload;
      const tool = p.action?.tool ?? "?";
      const packet =
        `🔔 Approval needed\n` +
        `${tool}${formatAmount(p.action?.params)}\n` +
        `agent: ${p.agent?.id ?? "?"} · principal: ${hold.initiating_principal}\n` +
        `rule: ${p.rule_id ?? "?"}${p.reason ? " — " + p.reason : ""}\n` +
        (p.context?.reasoning ? `reason: ${p.context.reasoning}\n` : "") +
        (await velocityReadout(pool, "acme-fintech", hold.initiating_principal));
      const kb = new InlineKeyboard()
        .text("Approve", `a:${hold.id}`)
        .text("Reject", `r:${hold.id}`);
      try {
        const msg = await bot.api.sendMessage(hold.approver_chat, packet, { reply_markup: kb });
        await pool.query("UPDATE holds SET telegram_message = $1 WHERE id = $2", [
          JSON.stringify({ chat_id: msg.chat.id, message_id: msg.message_id }),
          hold.id,
        ]);
      } catch (err) {
        console.error("[approvals] failed to send packet for hold", hold.id, err);
      }
    }
  }

  setInterval(() => {
    notifyNewHolds().catch((err) => console.error("[approvals] notify loop error", err));
  }, HOLD_POLL_MS);
}

main().catch((err) => {
  console.error("[approvals] fatal", err);
  process.exit(1);
});
