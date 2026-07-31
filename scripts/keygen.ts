import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadEnv } from "@charter/shared";

/**
 * Generate the Ed25519 signing key pair for checkpoint signing (D5). Private key signs checkpoints
 * in the gate (CHARTER_SIGNING_KEY_PATH); public key is what the independent verifier uses
 * (CHARTER_SIGNING_PUB_PATH). PEM format. Refuses to overwrite unless --force.
 */
loadEnv();

const privPath = resolve(process.cwd(), process.env.CHARTER_SIGNING_KEY_PATH ?? "./keys/signing.pem");
const pubPath = resolve(process.cwd(), process.env.CHARTER_SIGNING_PUB_PATH ?? "./keys/signing.pub.pem");
const force = process.argv.includes("--force");

if (!force && existsSync(privPath)) {
  console.log(`signing key already exists at ${privPath} (use --force to overwrite)`);
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(privPath), { recursive: true });
mkdirSync(dirname(pubPath), { recursive: true });
writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }) as string);

console.log("Ed25519 signing key pair written:");
console.log(`  private: ${privPath}`);
console.log(`  public:  ${pubPath}  (share with the verifier)`);
