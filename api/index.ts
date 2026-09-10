// Every gate route, behind one function. vercel.json rewrites /healthz and /v1/* here.
//
// The implementation is imported from dist-api/gate.mjs, a self-contained bundle produced by
// scripts/build-api.mjs during the build. See that script for why bundling rather than emitting:
// the repo runs under tsx, so emitted JS would still resolve cross-package imports to TypeScript.
import { handler } from "../dist-api/gate.mjs";

export default async function (req: unknown, res: unknown): Promise<void> {
  return handler(req, res);
}
