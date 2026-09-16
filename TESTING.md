# Trying Charter

You have been given a **sandbox**: a tenant of your own, with a key that is admin for that tenant and
nothing else. You cannot see or affect anyone else's data, so experiment freely — break things, spend
imaginary money, try to get something past the gate.

## Set up (1 minute)

1. Open the console: **https://usecharter.xyz/console/**
2. Scroll to the bottom → expand **Advanced — rules, connection**
3. Fill in **Connection**:

   | Field | Value |
   |---|---|
   | Base URL | *leave blank* |
   | Admin key | *(the key you were sent)* |

4. **Save**, then reload the page.

The header should read **RUNNING**. If the register says *"Cannot read the register (401)"*, the key
did not save — re-paste it, with no spaces.

## What Charter is

An AI agent that can spend money has to ask Charter first. Charter says allow, block, or ask a human —
and writes every decision to a ledger nobody can edit afterwards, including us.

## Try this, in order

**1 · Make an agent (REGISTER).** Give it a name, an owner, a daily limit. This is the point: an agent
is not a loose script, it is something a named person is accountable for.

**2 · Ask for permission (ASK).** Act as the agent. Amounts are in **paise** — ₹200 is `20000`.

| Try | Expect |
|---|---|
| `refund` for `20000` (₹200) | **ALLOW** — inside the limit |
| `refund` for `8000000` (₹80,000) | **ESCALATE** — too big to decide alone |
| `delete_record` | **DENY** — agents may never delete records |
| `initiate_payout` for `50000` | **DENY** — the policy permits it, the grant forbids it |

That last one is worth pausing on. A rule in the policy allows small payouts, but the authority a
human actually granted forbids payouts entirely — and the grant wins. A mistake in the rules cannot
exceed what a person signed off.

**3 · Approve something.** The ₹80,000 refund is waiting. Approve it as
`user:approver@sandbox.test` — note you cannot approve your own request; that refusal is deliberate.

**4 · Look at the record (RECORD).** Every decision, in order, each one hash-linked to the one before.

**5 · Check it yourself (PROOF).** Verification is done by a separate program that shares no code with
the part that writes the ledger — so it is a genuine second opinion rather than the same logic agreeing
with itself.

## Things worth trying to break

- Ask for a refund just over and just under the limit — where exactly does it flip?
- Spend the agent's whole daily budget, then ask for one more rupee.
- Make an agent that expires yesterday and try to use it.
- Try a tool the agent was never allowed.

## What we would like to know

1. What did you expect to happen that did not?
2. Where did you have to guess at what a word meant?
3. Was there a moment you thought it was broken? What were you doing?
4. Would you trust this with a real payment key? If not, what is missing?

## Notes

- The ledger is append-only on purpose: nothing you do can be deleted, only added to. That is the
  product, not a limitation.
- Your key is scoped to your sandbox. Pointing it at another tenant returns a 403 saying so.
- If you break the sandbox beyond use, say so — it can be reset in seconds.
