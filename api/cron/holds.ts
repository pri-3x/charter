// D9 hold-expiry sweeper, on a schedule.
//
// The long-running server runs this every 30s on a timer. A function cannot hold a timer, so Vercel
// Cron calls it instead — which means a hold's TTL is enforced to schedule granularity here. A hold
// past its TTL must resolve to DENY, so this failing silently would quietly remove the fail-closed
// guarantee; it returns the count so a missed run is visible.
import { sweepHolds } from "../../dist-api/gate.mjs";

export default async function (req: { headers: Record<string, string | undefined> }, res: {
  status: (n: number) => { json: (b: unknown) => void };
}): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    res.status(200).json({ expired: await sweepHolds() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "sweep failed" });
  }
}
