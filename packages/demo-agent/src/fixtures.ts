import { rupees } from "./money.js";

/**
 * Fixture customer + order data for the demo agent. All money is integer paise.
 *
 * Principals are RUN-SCOPED: the real principal string carries a short run tag
 * (`user:priya.n+k3x9a@example.com`). The ledger is append-only and the R5 velocity limit is a
 * 24-hour per-principal window, so a fixed principal would accumulate spend across runs and silently
 * change verdicts on the second run of the day. The run tag keeps every scenario deterministic and
 * re-runnable; the tag is printed so the ledger row is still findable.
 */

export interface Customer {
  key: string;
  name: string;
  /** Local part of the principal, before the run tag. */
  localPart: string;
  /** CRM record id — the subject of update_record / delete_record. */
  recordId: string;
  tier: "standard" | "priority";
}

export interface Order {
  id: string;
  customerKey: string;
  item: string;
  /** Order total, integer paise. */
  totalMinor: number;
  currency: "INR";
  status: "DELIVERED" | "IN_TRANSIT" | "CANCELLED";
  placedAt: string;
}

export const CUSTOMERS: readonly Customer[] = [
  { key: "priya", name: "Priya Nair", localPart: "priya.n", recordId: "CUST-88213", tier: "priority" },
  { key: "rahul", name: "Rahul Iyer", localPart: "rahul.i", recordId: "CUST-88477", tier: "standard" },
  { key: "aisha", name: "Aisha Khan", localPart: "aisha.k", recordId: "CUST-89004", tier: "standard" },
];

export const ORDERS: readonly Order[] = [
  {
    id: "ORD-4471",
    customerKey: "priya",
    item: "Noise-cancelling headphones",
    totalMinor: rupees(2499),
    currency: "INR",
    status: "DELIVERED",
    placedAt: "2026-07-11T09:12:00.000Z",
  },
  {
    // The A1 prompt-injection order: ₹80,000 — far above R2's ₹5,000 auto-approve ceiling.
    id: "ORD-4472",
    customerKey: "priya",
    item: "Espresso machine (commercial)",
    totalMinor: rupees(80_000),
    currency: "INR",
    status: "DELIVERED",
    placedAt: "2026-07-18T14:40:00.000Z",
  },
  {
    // The A2 structuring order: ₹40,000, which the customer wants split into 9 tranches.
    id: "ORD-4473",
    customerKey: "rahul",
    item: "Standing desk + ergonomic chair bundle",
    totalMinor: rupees(40_000),
    currency: "INR",
    status: "DELIVERED",
    placedAt: "2026-07-20T06:05:00.000Z",
  },
  {
    id: "ORD-4474",
    customerKey: "rahul",
    item: "USB-C docking station",
    totalMinor: rupees(7999),
    currency: "INR",
    status: "IN_TRANSIT",
    placedAt: "2026-07-24T11:30:00.000Z",
  },
  {
    id: "ORD-4475",
    customerKey: "aisha",
    item: "Mechanical keyboard",
    totalMinor: rupees(12_999),
    currency: "INR",
    status: "DELIVERED",
    placedAt: "2026-07-22T17:55:00.000Z",
  },
];

export function customer(key: string): Customer {
  const found = CUSTOMERS.find((c) => c.key === key);
  if (!found) throw new Error(`unknown fixture customer '${key}'`);
  return found;
}

export function order(id: string): Order {
  const found = ORDERS.find((o) => o.id === id);
  if (!found) throw new Error(`unknown fixture order '${id}'`);
  return found;
}

/** A short, URL/email-safe run tag. Deterministic within a run, unique across runs. */
export function newRunTag(): string {
  return Date.now().toString(36) + Math.floor(Math.random() * 36 ** 2).toString(36).padStart(2, "0");
}

/** Run-scoped principal for a fixture customer (see the note at the top of this file). */
export function principalOf(c: Customer, runTag: string): string {
  return `user:${c.localPart}+${runTag}@example.com`;
}

/** Run-scoped e-mail address for send_email. */
export function emailOf(c: Customer, runTag: string): string {
  return `${c.localPart}+${runTag}@example.com`;
}
