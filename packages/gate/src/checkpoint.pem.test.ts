import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { normalizePem, signerFromPem } from "./checkpoint.js";

const { privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

/** Every one of these is a real thing a deployment UI does to a multi-line value. */
const manglings: Array<[string, string]> = [
  ["untouched", PEM],
  ["trailing newline stripped", PEM.trimEnd()],
  ["literal backslash-n", PEM.replace(/\n/g, "\\n")],
  ["CRLF", PEM.replace(/\n/g, "\r\n")],
  ["newlines replaced with spaces", PEM.trim().replace(/\n/g, " ")],
  ["base64 of the whole PEM", Buffer.from(PEM, "utf8").toString("base64")],
  ["leading/trailing whitespace", `\n  ${PEM}  \n`],
  ["wrapped in double quotes", `"${PEM}"`],
  ["wrapped in single quotes", `'${PEM}'`],
];

describe("normalizePem", () => {
  for (const [name, mangled] of manglings) {
    it(`recovers a usable key from: ${name}`, () => {
      // The real assertion: it signs. Parsing is necessary but not sufficient.
      const sig = signerFromPem(mangled).sign("hello");
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);
    });
  }

  it("produces byte-identical output for every mangling", () => {
    const outs = new Set(manglings.map(([, m]) => normalizePem(m)));
    expect(outs.size).toBe(1);
  });

  it("all manglings sign identically, so checkpoints stay verifiable across a re-paste", () => {
    const sigs = new Set(manglings.map(([, m]) => signerFromPem(m).sign("same message")));
    expect(sigs.size).toBe(1);
  });

  it("still rejects something that is not a key at all", () => {
    expect(() => signerFromPem("not a key")).toThrow();
    expect(() => signerFromPem("")).toThrow();
  });

  // OpenSSL answers every one of these with the same DECODER message, which is what turned a
  // one-line misconfiguration into a long hunt. The point of these cases is the wording.
  describe("says which mistake was made", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "pem" }) as string;

    it("names a public key as a public key", () => {
      expect(() => signerFromPem(pub)).toThrow(/PUBLIC key/);
    });
    it("names a missing body", () => {
      expect(() => signerFromPem("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).toThrow(
        /no body/,
      );
    });
    it("names missing armour", () => {
      expect(() => signerFromPem("bm90IGEga2V5IGF0IGFsbCwganVzdCBiYXNlNjQ=")).toThrow(/no PEM armour/);
    });
    it("never echoes the key material into the error", () => {
      const secretish = PEM.split("\n")[1]!;
      try {
        signerFromPem("-----BEGIN PRIVATE KEY-----\n" + secretish + "\n-----END CERTIFICATE-----");
      } catch (e) {
        expect((e as Error).message).not.toContain(secretish);
      }
    });
  });
});
