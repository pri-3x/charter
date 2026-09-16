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
});
