import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { loadEnv, sha256Token } from "@charter/shared";
import { ulid } from "ulid";
import {
  makePool,
  PolicyStore,
  createDraft,
  activateDraft,
  grantAuthority,
  appendEntry,
} from "@charter/gate";

loadEnv();

const TENANT = "acme-fintech";
const AGENT_ID = "support-agent"; // the test workhorse; kept as the primary key in .seed
const DEMO_AGENT_ID = "refunds-agent"; // the demo star: "Meet Sarah's agent"
const EXPIRED_AGENT_ID = "collections-agent"; // chartered, but its charter has lapsed

const DAY = 86_400_000;

/** Charter fixtures. Each becomes a registry card + an authority grant, both ledger-evidenced. */
interface AgentFixture {
  id: string;
  name: string;
  owner: string;
  department: string;
  purpose: string;
  approverChain: string[];
  /** Days from now until the charter expires (negative = already lapsed). */
  charterDays: number;
  grant: {
    grantor: string;
    fromDays: number;
    untilDays: number;
    budgetMinor: number | null;
    allowed: string[];
    forbidden: string[];
    ref: string;
  };
}

const FIXTURES: AgentFixture[] = [
  {
    id: AGENT_ID,
    name: "Customer Support Agent",
    owner: "user:sarah@acme.co",
    department: "Customer Support",
    purpose: "Handles refunds, order lookups and customer email for the support queue.",
    approverChain: ["role:finance-lead"],
    charterDays: 90,
    grant: {
      grantor: "user:monty@acme.co",
      fromDays: -1,
      untilDays: 90,
      // High ceiling: this agent carries the automated scenario suite + soak load, so its grant must
      // not be the thing that fails those tests. The demo card below carries the realistic budget.
      budgetMinor: 500_000_000, // Rs 50,00,000 / day
      allowed: ["refund", "send_email", "lookup_order", "update_record", "delete_record"],
      forbidden: ["initiate_payout", "run_payroll", "production_db_query", "wire_transfer"],
      ref: "auth_2026_0001",
    },
  },
  {
    id: DEMO_AGENT_ID,
    name: "Refunds Agent",
    owner: "user:sarah@acme.co",
    department: "Customer Support",
    purpose: "Issues customer refunds within the Finance grant; escalates anything larger.",
    approverChain: ["role:finance-lead"],
    charterDays: 90,
    grant: {
      grantor: "user:monty@acme.co",
      fromDays: -1,
      untilDays: 90,
      budgetMinor: 10_000_000, // Rs 1,00,000 / day — the Charter §5.2 card
      allowed: ["refund", "send_email", "lookup_order", "update_record"],
      // Finance forbids payouts outright. The POLICY happens to allow small payouts (rule R6) — the
      // grant overrules it. A policy mistake cannot exceed the granted authority (scenario S22).
      forbidden: ["initiate_payout", "run_payroll", "production_db_query"],
      ref: "auth_2026_0071",
    },
  },
  {
    id: EXPIRED_AGENT_ID,
    name: "Collections Agent",
    owner: "user:steven@acme.co",
    department: "Collections",
    purpose: "Pilot collections follow-ups. Charter lapsed and was not renewed.",
    approverChain: ["role:finance-lead"],
    charterDays: -26, // lapsed
    grant: {
      grantor: "user:monty@acme.co",
      fromDays: -116,
      untilDays: -26,
      budgetMinor: 2_500_000,
      allowed: ["refund", "send_email", "lookup_order"],
      forbidden: ["initiate_payout", "run_payroll", "production_db_query"],
      ref: "auth_2026_0043",
    },
  },
];

const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString();

async function main(): Promise<void> {
  const url = process.env.POSTGRES_SUPERUSER_URL;
  if (!url) throw new Error("POSTGRES_SUPERUSER_URL not set");

  // A fixed key can be pinned via SEED_AGENT_KEY (handy for demos); otherwise generate one.
  const keys: Record<string, string> = {
    [AGENT_ID]: process.env.SEED_AGENT_KEY ?? `chr_${randomBytes(24).toString("base64url")}`,
    [DEMO_AGENT_ID]: process.env.SEED_DEMO_AGENT_KEY ?? `chr_${randomBytes(24).toString("base64url")}`,
    [EXPIRED_AGENT_ID]: `chr_${randomBytes(24).toString("base64url")}`,
  };
  const adminKey = process.env.CHARTER_ADMIN_KEY ?? "change-me-admin-key";

  // ---- tenant + principals + seq row (must exist before any ledger entry) ---------------------
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO tenants (id, name, approver_chat)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [TENANT, "Acme Fintech", process.env.TELEGRAM_APPROVER_CHAT ?? null],
    );

    // Owners and approvers. Sarah owns the agents (accountability); Monty and Steven approve.
    for (const p of [
      { id: "user:monty@acme.co", name: "Monty Sharma", tg: 100000001, roles: ["finance-lead"] },
      { id: "user:steven@acme.co", name: "Steven Rao", tg: 100000002, roles: ["finance-lead"] },
      { id: "user:sarah@acme.co", name: "Sarah Menon", tg: 100000003, roles: ["support-lead"] },
    ]) {
      await client.query(
        `INSERT INTO principals (id, tenant_id, display_name, telegram_user_id, roles)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, id)
         DO UPDATE SET display_name = EXCLUDED.display_name,
                       telegram_user_id = EXCLUDED.telegram_user_id,
                       roles = EXCLUDED.roles`,
        [p.id, TENANT, p.name, p.tg, p.roles],
      );
    }

    await client.query(
      `INSERT INTO ledger_seq (tenant_id, last_seq) VALUES ($1, 0)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANT],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }

  const pool = makePool(url);
  try {
    // ---- policy: example.acme.yaml as active version 1, via the real draft→activate path --------
    const active = await pool.query(
      "SELECT 1 FROM policies WHERE tenant_id = $1 AND status = 'active'",
      [TENANT],
    );
    if (active.rowCount === 0) {
      const yamlText = readFileSync(resolve(process.cwd(), "policies/example.acme.yaml"), "utf8");
      const store = new PolicyStore(pool);
      const { draftId } = await createDraft(pool, yamlText);
      const { version } = await activateDraft(pool, store, draftId);
      console.log(`  policy:        example.acme.yaml activated as version ${version}`);
    } else {
      console.log("  policy:        active version already present (skipped)");
    }

    // ---- registry: charter each agent + issue its grant ----------------------------------------
    for (const f of FIXTURES) {
      const fingerprint = sha256Token(keys[f.id]!);
      const existing = await pool.query("SELECT 1 FROM agents WHERE tenant_id = $1 AND id = $2", [
        TENANT,
        f.id,
      ]);

      if (existing.rowCount === 0) {
        // Registration is a ledger event (Charter §5.1) — agents row + AGENT_REGISTERED, one txn.
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(
            `INSERT INTO agents (id, tenant_id, name, key_fingerprint, max_autonomy, status,
                                 owner_principal, department, purpose, approver_chain, expires_at)
             VALUES ($1,$2,$3,$4,'ALLOW','ACTIVE',$5,$6,$7,$8,$9::timestamptz)`,
            [
              f.id,
              TENANT,
              f.name,
              fingerprint,
              f.owner,
              f.department,
              f.purpose,
              f.approverChain,
              iso(f.charterDays),
            ],
          );
          await appendEntry(c, {
            tenant: TENANT,
            kind: "AGENT_REGISTERED",
            entryId: ulid(),
            body: {
              agent: { id: f.id, name: f.name, key_fingerprint: fingerprint, max_autonomy: "ALLOW" },
              owner_principal: f.owner,
              department: f.department,
              purpose: f.purpose,
              approver_chain: f.approverChain,
              expires_at: iso(f.charterDays),
            },
          });
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          c.release();
        }
      } else {
        // Re-seeding an existing DB: refresh the key + charter fields, no duplicate ledger event.
        await pool.query(
          `UPDATE agents SET key_fingerprint = $3, name = $4, owner_principal = $5, department = $6,
                             purpose = $7, approver_chain = $8, expires_at = $9::timestamptz,
                             status = CASE WHEN status = 'SUSPENDED' THEN 'ACTIVE' ELSE status END
            WHERE tenant_id = $1 AND id = $2`,
          [
            TENANT,
            f.id,
            fingerprint,
            f.name,
            f.owner,
            f.department,
            f.purpose,
            f.approverChain,
            iso(f.charterDays),
          ],
        );
      }

      const liveGrant = await pool.query(
        "SELECT 1 FROM authorities WHERE tenant_id = $1 AND agent_id = $2 AND status = 'ACTIVE'",
        [TENANT, f.id],
      );
      if (liveGrant.rowCount === 0) {
        const res = await grantAuthority(pool, {
          tenant: TENANT,
          agentId: f.id,
          grantorPrincipal: f.grant.grantor,
          validFrom: iso(f.grant.fromDays),
          validUntil: iso(f.grant.untilDays),
          budgetMinor: f.grant.budgetMinor,
          budgetCurrency: "INR",
          budgetWindowMinutes: 1440,
          allowedTools: f.grant.allowed,
          forbiddenOps: f.grant.forbidden,
          ref: f.grant.ref,
        });
        if (!res.ok) throw new Error(`grant failed for ${f.id}: ${res.reason}`);
      }
    }
  } finally {
    await pool.end();
  }

  // Persist the credentials the integration tests and dev tooling need (gitignored).
  const seedDir = resolve(process.cwd(), ".seed");
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(
    resolve(seedDir, "agent-key.json"),
    JSON.stringify(
      {
        tenant: TENANT,
        agentId: AGENT_ID,
        apiKey: keys[AGENT_ID],
        adminKey,
        agents: {
          [AGENT_ID]: keys[AGENT_ID],
          [DEMO_AGENT_ID]: keys[DEMO_AGENT_ID],
          [EXPIRED_AGENT_ID]: keys[EXPIRED_AGENT_ID],
        },
      },
      null,
      2,
    ),
  );

  console.log("seed complete");
  console.log(`  tenant:        ${TENANT}`);
  console.log(`  registry:      ${FIXTURES.map((f) => f.id).join(", ")}`);
  console.log(`  principals:    monty + steven (finance-lead), sarah (support-lead, owner)`);
  console.log("");
  console.log("  ==== AGENT API KEY (shown once) ====");
  console.log(`  ${keys[AGENT_ID]}`);
  console.log("  ====================================");
  console.log("  (all three keys written to .seed/agent-key.json for local dev + tests)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
