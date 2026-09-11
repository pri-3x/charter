import { describe, it, expect } from "vitest";
import { assertSafeEndpoint, isPrivateAddress, redact, EgressConfigError } from "./egress.js";

describe("assertSafeEndpoint", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(assertSafeEndpoint("https://api.stripe.com/v1/refunds").hostname).toBe("api.stripe.com");
  });

  it("refuses plain http unless loopback is explicitly allowed", () => {
    expect(() => assertSafeEndpoint("http://api.example.test/x")).toThrow(EgressConfigError);
    expect(assertSafeEndpoint("http://localhost:9999/x", true).port).toBe("9999");
  });

  it("refuses loopback by default", () => {
    for (const u of ["https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x"]) {
      expect(() => assertSafeEndpoint(u)).toThrow(/loopback/);
    }
  });

  it("refuses cloud metadata and private ranges", () => {
    // 169.254.169.254 is the reason this check exists.
    for (const ip of ["169.254.169.254", "10.0.0.5", "172.16.0.1", "192.168.1.1", "100.64.0.1"]) {
      expect(() => assertSafeEndpoint(`https://${ip}/x`)).toThrow(/private or link-local/);
    }
    expect(() => assertSafeEndpoint("https://[fd00::1]/x")).toThrow(/private or link-local/);
    expect(() => assertSafeEndpoint("https://[fe80::1]/x")).toThrow(/private or link-local/);
  });

  it("refuses a URL with embedded credentials", () => {
    expect(() => assertSafeEndpoint("https://user:pw@api.example.com/x")).toThrow(/embed credentials/);
  });

  it("refuses a malformed URL", () => {
    expect(() => assertSafeEndpoint("not a url")).toThrow(/not a valid URL/);
  });

  it("still refuses private addresses even when loopback is allowed", () => {
    // Dev convenience must not become a hole: allowLoopback covers localhost, not the whole LAN.
    expect(() => assertSafeEndpoint("https://169.254.169.254/x", true)).toThrow(/private or link-local/);
    expect(() => assertSafeEndpoint("https://10.0.0.5/x", true)).toThrow(/private or link-local/);
  });
});

describe("isPrivateAddress", () => {
  it("classifies public addresses as public", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "34.120.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
  it("catches v4-mapped v6 forms", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("redact", () => {
  const SECRET = "sk_live_abc123";
  it("removes the secret from a string an upstream echoed back", () => {
    expect(redact(`bad key: ${SECRET}`, SECRET)).toBe("bad key: [redacted]");
  });
  it("removes it from nested objects and arrays", () => {
    const out = redact({ e: { msg: SECRET, list: [SECRET, "fine"] } }, SECRET) as {
      e: { msg: string; list: string[] };
    };
    expect(out.e.msg).toBe("[redacted]");
    expect(out.e.list).toEqual(["[redacted]", "fine"]);
  });
  it("leaves unrelated content alone", () => {
    expect(redact({ ok: true, n: 5 }, SECRET)).toEqual({ ok: true, n: 5 });
  });
});
