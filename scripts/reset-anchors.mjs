// Clear the out-of-band anchor record when the chain itself is destroyed (db:reset).
//
// anchors.log is the record kept OUTSIDE the database so a truncated ledger can be detected (T6):
// the verifier compares the highest anchored seq_to against the highest seq present. Keeping stale
// anchors from a previous chain across a db:reset therefore reports a tamper that never happened —
// the anchors are real, the entries they describe are simply gone. A fresh chain gets fresh anchors.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), process.env.ANCHORS_LOG_PATH ?? "./anchors.log");
writeFileSync(path, "");
console.log(`anchors cleared: ${path}`);
