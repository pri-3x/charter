/**
 * Money formatting. Every amount in the demo is an INTEGER number of paise (CLAUDE.md / D13) — this
 * module never divides into a float. Rupees and paise are split with integer arithmetic and the
 * rupee part is grouped in the Indian convention (…,##,##,###).
 */

export const PAISE_PER_RUPEE = 100;

/** Rupees (integer) → paise. Rejects non-integers so a fixture typo cannot introduce a float. */
export function rupees(amount: number): number {
  if (!Number.isInteger(amount)) throw new TypeError(`rupees() takes an integer, got ${amount}`);
  return amount * PAISE_PER_RUPEE;
}

/** Group an integer rupee string in the Indian convention: 8000000 → "80,00,000". */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const groups: string[] = [];
  let rest = head;
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${groups.join(",")},${tail}`;
}

/** Paise → "₹80,00,000.00". Integer math only. */
export function formatPaise(minor: number): string {
  if (!Number.isInteger(minor)) throw new TypeError(`formatPaise() takes an integer, got ${minor}`);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / PAISE_PER_RUPEE);
  const frac = abs % PAISE_PER_RUPEE;
  return `${sign}₹${groupIndian(String(whole))}.${String(frac).padStart(2, "0")}`;
}

/** "₹200.00 (20000 paise)" — used wherever the raw minor units also matter for the audit story. */
export function formatPaiseWithMinor(minor: number): string {
  return `${formatPaise(minor)} (${minor} paise)`;
}
