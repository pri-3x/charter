import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope encryption for tool credentials (Pattern B).
 *
 * AES-256-GCM, not CBC and not "encrypt then hope": the tag is what stops a stored ciphertext being
 * flipped byte-by-byte by anyone with write access to the row. Postgres is the store, not the trust
 * boundary — a DBA with SELECT on tool_credentials must not thereby hold the payment key, which is
 * the entire reason this is encrypted rather than merely a column called `secret`.
 *
 * The key lives in CHARTER_CREDENTIAL_KEY (base64, 32 bytes) and never in the database. Losing it
 * means losing the credentials, which is the correct failure mode: the alternative is a key stored
 * next to the thing it protects.
 *
 * The egress descriptor is bound in as GCM additional authenticated data. This matters more than it
 * looks: endpoint_url is an ordinary plaintext column, so without AAD anyone with UPDATE on the row
 * could repoint the destination at a server they control and the gate would dutifully attach the
 * production credential to it. With the descriptor as AAD the secret decrypts ONLY alongside the
 * destination it was sealed for — editing the URL does not redirect the credential, it destroys it.
 */

export interface SealedSecret {
  ct: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** SHA-256 prefix of the PLAINTEXT: identifies which key is installed without revealing it. */
  fingerprint: string;
}

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce; 12 bytes is the size GCM is actually specified for

export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyError";
  }
}

/**
 * Read the master key. Throws rather than generating one: a gate that invents a key at boot would
 * encrypt happily and then be unable to decrypt anything after a restart, and would report success
 * the whole time. Fail closed, loudly, at startup.
 */
export function loadCredentialKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new CredentialKeyError(
      "CHARTER_CREDENTIAL_KEY is not set — credential custody cannot be used without it. " +
        "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), "base64");
  } catch {
    throw new CredentialKeyError("CHARTER_CREDENTIAL_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new CredentialKeyError(
      `CHARTER_CREDENTIAL_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/** SHA-256 prefix of a secret. Short enough to read aloud, long enough not to collide in practice. */
export function fingerprint(secret: string): string {
  return "sha256:" + createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

/**
 * The bytes the secret is bound to. Field-separated with a character that cannot occur in a URL or a
 * header name, so ("a","bc") and ("ab","c") cannot canonicalise to the same AAD.
 */
export interface EgressBinding {
  tenant: string;
  tool: string;
  endpointUrl: string;
  method: string;
  authScheme: string;
  authHeader?: string | undefined;
}

export function bindingBytes(b: EgressBinding): Buffer {
  return Buffer.from(
    [b.tenant, b.tool, b.endpointUrl, b.method, b.authScheme, b.authHeader ?? ""].join("\u0000"),
    "utf8",
  );
}

export function seal(key: Buffer, secret: string, binding: EgressBinding): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(bindingBytes(binding));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ct, iv, tag: cipher.getAuthTag(), fingerprint: fingerprint(secret) };
}

/**
 * Decrypt. Throws on a bad tag — which is the point: a tampered row must not silently decrypt to
 * garbage that then gets sent to a payment provider as an Authorization header.
 */
export function open(
  key: Buffer,
  sealed: { ct: Buffer; iv: Buffer; tag: Buffer },
  binding: EgressBinding,
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  decipher.setAAD(bindingBytes(binding));
  return Buffer.concat([decipher.update(sealed.ct), decipher.final()]).toString("utf8");
}

/** Constant-time compare, for checking a presented fingerprint against a stored one. */
export function fingerprintMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
