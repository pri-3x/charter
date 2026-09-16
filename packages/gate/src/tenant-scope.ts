import type { FastifyRequest } from "fastify";
import type { AuthResult } from "./auth.js";

/**
 * Bind an admin request to the tenant its key is allowed to touch.
 *
 * The global operator key (CHARTER_ADMIN_KEY) may address any tenant, so it is left alone. A
 * tenant-scoped key must not be able to address another tenant — and the interesting design
 * question is how to guarantee that across eighteen admin routes without relying on eighteen
 * correct checks.
 *
 * Validating would be the obvious approach: read `?tenant=`, compare, reject on mismatch. It is
 * also fragile, because it fails OPEN on the route someone forgets to update — that route reads
 * `req.query.tenant ?? DEFAULT_TENANT` and happily serves the real tenant's ledger.
 *
 * So this PINS instead. For a scoped key the tenant parameter is overwritten with the key's own
 * tenant before the handler runs. A route that never checks anything still cannot be pointed
 * anywhere else, because by the time it reads the parameter, the parameter says the sandbox. The
 * failure mode of forgetting is "the sandbox admin sees the sandbox", which is correct.
 *
 * Requests that name a *different* tenant explicitly are still refused rather than silently
 * redirected — a tester who types `?tenant=acme-fintech` should be told no, not handed their own
 * data and left believing it is someone else's.
 */
export interface ScopeDenial {
  code: 403;
  error: string;
}

export function pinTenant(
  req: FastifyRequest,
  auth: AuthResult,
): ScopeDenial | null {
  if (auth.kind !== "admin" || !auth.tenant) return null; // global operator, or not an admin route
  const scoped = auth.tenant;

  const q = req.query as Record<string, unknown> | undefined;
  const asked = typeof q?.tenant === "string" ? q.tenant : undefined;
  if (asked && asked !== scoped) {
    return {
      code: 403,
      error: `this key is scoped to tenant '${scoped}' and cannot address '${asked}'`,
    };
  }
  if (q && typeof q === "object") q.tenant = scoped;

  // Bodies that carry a tenant (credential registration) get the same treatment. Policy documents
  // name their tenant inside the YAML and are handled at their own route, where the parsed document
  // is available.
  const b = req.body as Record<string, unknown> | undefined;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const bodyTenant = typeof b.tenant === "string" ? b.tenant : undefined;
    if (bodyTenant && bodyTenant !== scoped) {
      return {
        code: 403,
        error: `this key is scoped to tenant '${scoped}' and cannot address '${bodyTenant}'`,
      };
    }
    if ("tenant" in b || bodyTenant !== undefined) b.tenant = scoped;
  }
  return null;
}

/** The tenant an admin request is confined to, if any. */
export function scopeOf(auth: AuthResult): string | undefined {
  return auth.kind === "admin" ? auth.tenant : undefined;
}
