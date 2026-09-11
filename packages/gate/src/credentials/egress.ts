import { isIP } from "node:net";
import type { LiveCredential, Method, AuthScheme } from "./store.js";

/**
 * The outbound call Charter makes on the agent's behalf (Pattern B).
 *
 * Two properties this file exists to guarantee:
 *
 *  1. **What is sent is what was authorized.** The body is the params the policy evaluated — they
 *     come from the caller on the ALLOW path and from the immutable ledger entry on the resume path.
 *     The caller never supplies a URL, a method, or a header; all three come from the admin-
 *     registered descriptor. Otherwise Charter would be an SSRF proxy that attaches production
 *     credentials to whatever it is pointed at.
 *
 *  2. **The secret does not escape.** It is attached to exactly one outbound request and never
 *     appears in a return value, an error message, or a log line. `redact()` below is applied to
 *     everything that leaves this module, because the usual way a key ends up in a log is an
 *     upstream that echoes the Authorization header back inside a 401 body.
 */

export interface EgressResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when the upstream returned JSON, else the text body, truncated. */
  body: unknown;
  duration_ms: number;
}

export class EgressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressConfigError";
  }
}

const MAX_BODY_CHARS = 8192;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Reject a destination that a credential must never be sent to.
 *
 * Enforced at registration (so bad config fails at install time, in front of a human) and again
 * before every call (so a row edited afterwards cannot quietly take effect). Loopback and private
 * ranges are refused because a gate that will POST your payment key to 169.254.169.254 is a cloud
 * metadata exfiltration primitive. `allowLoopback` exists only for local development and tests.
 */
export function assertSafeEndpoint(raw: string, allowLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressConfigError(`endpoint_url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:")) {
    throw new EgressConfigError("endpoint_url must be https (http is allowed only for loopback in dev)");
  }
  if (url.username || url.password) {
    throw new EgressConfigError("endpoint_url must not embed credentials");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "::1" || /^127\./.test(host) || host.endsWith(".localhost");
  if (loopback) {
    if (!allowLoopback) throw new EgressConfigError("endpoint_url must not point at loopback");
    return url;
  }
  if (isIP(host)) {
    // A literal IP skips DNS, so this check is complete for it. Hostnames are a different problem
    // (DNS rebinding) and are deliberately NOT resolved here — see the note below.
    if (isPrivateAddress(host)) {
      throw new EgressConfigError(`endpoint_url must not point at a private or link-local address (${host})`);
    }
  }
  return url;
}

/** RFC1918 / link-local / unique-local / metadata ranges, for literal IPs. */
export function isPrivateAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const p = host.split(".").map(Number) as [number, number, number, number];
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local, incl. cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique-local fc00::/7
  if (h.startsWith("::ffff:")) return isPrivateAddress(h.slice(7)); // v4-mapped
  return false;
}
// NOTE (honest limitation): a hostname is not resolved before the request, so a DNS name that
// resolves to a private address is not caught here, and even if it were, the resolution used for
// the check need not be the one the request uses (rebinding). Closing that properly means pinning
// the resolved address and connecting to it directly with a custom agent. Registration is
// admin-only, so the exposure is a misconfigured admin rather than a hostile caller — but it is a
// real gap and is recorded as such rather than papered over.

/** Strip anything that looks like the secret out of text that is about to be stored or logged. */
export function redact(value: unknown, secret: string): unknown {
  if (!secret) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.split(secret).join("[redacted]");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value);
}

function authHeaders(
  cred: { authScheme: AuthScheme; authHeader?: string | undefined },
  secret: string,
): Record<string, string> {
  switch (cred.authScheme) {
    case "bearer":
      return { authorization: `Bearer ${secret}` };
    case "basic":
      return { authorization: `Basic ${Buffer.from(secret, "utf8").toString("base64")}` };
    case "header": {
      if (!cred.authHeader) throw new EgressConfigError("auth_scheme 'header' requires auth_header");
      return { [cred.authHeader.toLowerCase()]: secret };
    }
  }
}

/**
 * Perform the call. Never throws for an upstream error status — a 402 from a payment provider is an
 * outcome to record, not a gate fault. Throws only when the call could not be made at all.
 */
export async function callTool(
  cred: LiveCredential,
  params: Record<string, unknown>,
  opts: { allowLoopback?: boolean; timeoutMs?: number } = {},
): Promise<EgressResult> {
  const url = assertSafeEndpoint(cred.endpointUrl, opts.allowLoopback ?? false);
  const method: Method = cred.method;
  const sendsBody = method !== "GET" && method !== "DELETE";

  // A GET/DELETE cannot carry the authorized params in a body, so they go in the query string —
  // still exactly the params that were checked, just in the only place this method has for them.
  if (!sendsBody) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(sendsBody ? { "content-type": "application/json" } : {}),
        ...authHeaders(cred, cred.secret),
      } as Record<string, string>,
      ...(sendsBody ? { body: JSON.stringify(params) } : {}),
      signal: ac.signal,
      redirect: "manual", // a 302 must not silently carry the credential to a new host
    });

    const text = (await res.text()).slice(0, MAX_BODY_CHARS);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON; keep the text */
    }
    return {
      ok: res.ok,
      status: res.status,
      body: redact(body, cred.secret),
      duration_ms: Number((performance.now() - started).toFixed(2)),
    };
  } finally {
    clearTimeout(timer);
  }
}
