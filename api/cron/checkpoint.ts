// Merkle checkpoint worker, on a schedule (SPEC 4.3, D5).
//
// Without this running, entry-level hashes still catch a naive edit but nothing catches a rewrite
// that re-chains the tail — the signed checkpoint is the only thing that does. So a deployment where
// this never fires has materially weaker tamper evidence than one where it does, and the response
// says which of those happened.
import { sealCheckpoint } from "../../dist-api/gate.mjs";

export default async function (req: { headers: Record<string, string | undefined> }, res: {
  status: (n: number) => { json: (b: unknown) => void };
}): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    res.status(200).json(await sealCheckpoint());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "seal failed" });
  }
}
