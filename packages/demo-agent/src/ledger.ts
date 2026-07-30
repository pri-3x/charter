/**
 * Read-only ledger access over the admin HTTP API. The demo asserts against the LEDGER, not just the
 * HTTP verdict — "the gate said DENY" is a claim; "there is a durable, hash-chained entry that says
 * DENY" is evidence. Everything here is a GET; nothing in this file can write.
 */

export interface LedgerEntry {
  seq: number;
  entry_id: string;
  ts: string;
  tenant: string;
  kind: string;
  prev_hash: string;
  entry_hash: string;
  verdict?: string;
  rule_id?: string;
  reason?: string;
  principal?: string;
  agent?: { id?: string };
  action?: { tool?: string; params?: Record<string, unknown>; params_hash?: string };
  context?: { reasoning?: string; conversation_ref?: string };
  /** OUTCOME entries only. */
  verdict_entry_id?: string;
  status?: string;
  [key: string]: unknown;
}

export interface LedgerReaderOptions {
  baseUrl: string;
  adminKey: string;
  tenant: string;
}

export class LedgerReadError extends Error {}

export class LedgerReader {
  constructor(private readonly opts: LedgerReaderOptions) {}

  private async page(params: Record<string, string>): Promise<{ entries: LedgerEntry[]; next: number | null }> {
    const qs = new URLSearchParams({ tenant: this.opts.tenant, ...params });
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/v1/ledger?${qs.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.opts.adminKey}` } });
    if (res.status !== 200) {
      throw new LedgerReadError(`GET /v1/ledger returned HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { entries: LedgerEntry[]; next_from_seq: number | null };
    return { entries: body.entries, next: body.next_from_seq };
  }

  /** Current head sequence number (0 when the chain is empty). */
  async headSeq(): Promise<number> {
    // Walk forward in big pages; the POC ledger is small enough that this is cheap and needs no
    // extra endpoint. `limit` is capped at 500 server-side.
    let from = 0;
    let head = 0;
    for (;;) {
      const { entries, next } = await this.page({ from_seq: String(from), limit: "500" });
      const last = entries[entries.length - 1];
      if (last) head = last.seq;
      if (next === null) return head;
      from = next;
    }
  }

  /** Every entry with seq >= fromSeq, in seq order, following pagination. */
  async entriesFrom(fromSeq: number, filter: { kind?: string; tool?: string } = {}): Promise<LedgerEntry[]> {
    const out: LedgerEntry[] = [];
    let from = Math.max(0, fromSeq);
    for (;;) {
      const params: Record<string, string> = { from_seq: String(from), limit: "500" };
      if (filter.kind) params.kind = filter.kind;
      if (filter.tool) params.tool = filter.tool;
      const { entries, next } = await this.page(params);
      out.push(...entries);
      if (next === null) return out;
      from = next;
    }
  }

  async entry(entryId: string, fromSeq = 0): Promise<LedgerEntry | undefined> {
    const all = await this.entriesFrom(fromSeq);
    return all.find((e) => e.entry_id === entryId);
  }

  /** OUTCOME entry for a VERDICT entry id, if one has been reported. */
  async outcomeFor(verdictEntryId: string, fromSeq = 0): Promise<LedgerEntry | undefined> {
    const outcomes = await this.entriesFrom(fromSeq, { kind: "OUTCOME" });
    return outcomes.find((e) => e.verdict_entry_id === verdictEntryId);
  }
}

export interface ChainCheck {
  checked: number;
  ok: boolean;
  /** Seq of the first entry whose prev_hash does not match its predecessor's entry_hash. */
  firstBreakSeq?: number;
  detail: string;
}

/**
 * prev_hash[n] == entry_hash[n-1] across a contiguous range, plus seq continuity. Starting the range
 * one entry BEFORE the region of interest also proves the region links into the pre-existing chain.
 * (Full-chain + checkpoint + signature verification is `npm run verify`.)
 */
export function verifyChainLinks(entries: readonly LedgerEntry[]): ChainCheck {
  if (entries.length < 2) {
    return { checked: entries.length, ok: true, detail: "fewer than two entries — nothing to link" };
  }
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    if (cur.seq !== prev.seq + 1) {
      return {
        checked: entries.length,
        ok: false,
        firstBreakSeq: cur.seq,
        detail: `seq gap: ${prev.seq} → ${cur.seq}`,
      };
    }
    if (cur.prev_hash !== prev.entry_hash) {
      return {
        checked: entries.length,
        ok: false,
        firstBreakSeq: cur.seq,
        detail: `prev_hash mismatch at seq ${cur.seq}`,
      };
    }
  }
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  return {
    checked: entries.length,
    ok: true,
    detail: `seq ${first.seq}..${last.seq} link cleanly (prev_hash[n] == entry_hash[n-1])`,
  };
}
