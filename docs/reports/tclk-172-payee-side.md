# Payee-side check against #172: 24 of 24 closed deals kept no rail evidence

Draft for `flop-labs/tclk` issue #172. Measurements only, own mistakes included.
Not posted — awaiting the operator's decision.

---

#172 reports that `claimed` can be reached from a signed transcript without the
settlement rail being checked, and #173 is the open draft that would separate
"a frame said so" from "the money existed". We run the payee side of a TCLK
agent continuously, so the question is answerable from our own records rather
than from the shared stream, and that is a different vantage point from the
offer-room snapshots in this thread.

## What we found in our own state

`data/local/tclk-state.json`, read 2026-09-21 12:2xZ:

| | |
|---|---|
| closed as `completed` | 24 |
| whose `reason` is `claimed` | 24 |
| carrying any rail-shaped field | **0** |

The stored keys are `contract, room, payer, job, acceptedAt, closedAt, reason`.
There is no settlement status, no rail identifier and no reference of any kind,
so a later reader of our own record — human or agent — cannot tell a verified
settlement from an unverified one. That is the reporting gap #172 describes,
reproduced from the other side of the deal.

## The correction we owe our own first reading

Our first conclusion from that table was "we never check the rail". That was
wrong, and the code says so: before emitting a `receipt` frame the claim path
re-reads the rail and posts `outcome: claimed` **only if the rail agrees**,
otherwise it logs `receipt withheld: the rail reads <status>, not claimed`.
That check was added on 2026-09-02 after tclk began rejecting receipt frames
whose claimed outcome contradicts the contract's terminal state.

So the defect on our side is narrower than the table suggests: we verify at the
moment of claiming and then discard the verdict. Fixed in our agent by storing
the rail's own status and the rail kind on the closed record.

## The part that is not a bug and still matters

Our rail is `paper` — a `/kv/` note, not a chain. A paper rail that reads
`claimed` is evidence that a note was written, and nothing more. This agrees
with what this repository already says of itself ("Alpha: no rail holds value
yet") and with PR #171 declaring its chain a mock with the RPC unwired, so we
claim no loss and allege nothing. The point is only that an agent's own history
should record which rail answered and what it said, because `claimed` alone
reads as money to anything that consumes it later.

Concretely, this is why the `settlementView()` vocabulary proposed in #173 —
`none / unverified / unfunded / funded / claimed / refunded` — is worth having
at the record level and not only at the API level: the distinction has to
survive into storage, or the next reader loses it exactly as we did.

## Limits of this measurement

- One agent, one payee identity, 24 deals. Not a survey.
- It says nothing about whether any counterparty misrepresented anything.
- Our 50 abandoned deals and 194 no-lock cooldowns are counterparties that
  never locked; that is a separate question from this one and we are not
  offering it as evidence here.
