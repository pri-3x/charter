import { describe, it, expect } from "vitest";
import { formatPaise, formatPaiseWithMinor, groupIndian, rupees, PAISE_PER_RUPEE } from "./money.js";

describe("money — integer minor units only (D13)", () => {
  it("converts whole rupees to paise", () => {
    expect(rupees(200)).toBe(20_000);
    expect(rupees(80_000)).toBe(8_000_000);
    expect(PAISE_PER_RUPEE).toBe(100);
  });

  it("refuses a fractional rupee amount rather than silently rounding", () => {
    expect(() => rupees(199.99)).toThrow(TypeError);
  });

  it("groups rupees in the Indian convention", () => {
    expect(groupIndian("1")).toBe("1");
    expect(groupIndian("999")).toBe("999");
    expect(groupIndian("1000")).toBe("1,000");
    expect(groupIndian("100000")).toBe("1,00,000");
    expect(groupIndian("8000000")).toBe("80,00,000");
    expect(groupIndian("12345678")).toBe("1,23,45,678");
  });

  it("formats paise without ever dividing into a float", () => {
    expect(formatPaise(0)).toBe("₹0.00");
    expect(formatPaise(1)).toBe("₹0.01");
    expect(formatPaise(20_000)).toBe("₹200.00");
    expect(formatPaise(499_900)).toBe("₹4,999.00");
    expect(formatPaise(500_100)).toBe("₹5,001.00");
    expect(formatPaise(4_000_005)).toBe("₹40,000.05");
    // 8,000,000 paise is Rs 80,000 — the A1 order total.
    expect(formatPaise(8_000_000)).toBe("₹80,000.00");
    // 1,00,00,000 paise is Rs 1,00,000 — refunds-agent's daily grant ceiling.
    expect(formatPaise(10_000_000)).toBe("₹1,00,000.00");
  });

  it("keeps the paise remainder exact for amounts that are not whole rupees", () => {
    // 444445 paise = Rs 4,444 and 45 paise — the A2 tranche amount.
    expect(formatPaise(444_445)).toBe("₹4,444.45");
    expect(formatPaise(-20_000)).toBe("-₹200.00");
  });

  it("shows minor units alongside the rupee rendering", () => {
    expect(formatPaiseWithMinor(20_000)).toBe("₹200.00 (20000 paise)");
  });

  it("refuses a fractional paise value", () => {
    expect(() => formatPaise(20_000.5)).toThrow(TypeError);
  });
});
