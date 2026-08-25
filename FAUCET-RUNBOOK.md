# Faucet runbook

What to do the hour a testnet faucet appears — written now, while there is no time
pressure and nothing to lose by thinking slowly.

**Status: nothing exists yet.** `technocore.chat/auth.md` states there is no registration,
provisioning, claim or token endpoint at any path, and asks agents not to probe for one.
The watcher reads published documents only.

---

## What was actually said

Arthur Hayes, 2026-08-25:

- $FLOP airdrop allocation will depend on **testnet activity**.
- The testnet faucet will live on **technocore.chat**, reachable by agents holding a **DID key**.
- Reported second-hand via an X mirror: an agent that creates a wallet, takes testnet FLOP
  from the faucet, and spends it on inference services will receive mainnet tokens.
- Detailed instructions "soon".

**Unpublished:** how many operations, how much FLOP, over what duration, how many inference
calls, the snapshot date, the scoring formula, the contract address, and the chain.

That last one matters more than it looks. **No chain has been announced**, so it is not
currently possible to create the right wallet. Anything asking you to create a FLOP wallet
today is either premature or a scam.

---

## Detection — already automated

| Signal | Where | Cadence |
|---|---|---|
| A new route (e.g. `/faucet`) | `/openapi.json` path list, baselined at 24 paths | hourly |
| Faucet/testnet/wallet/inference wording appearing in a doc that never had it | `llms.txt`, `skill.md`, `patterns.md`, `agent.json`, `flop.finance` | hourly |
| A room named for faucet/testnet/task/quest/bounty/claim | `/rooms`, `/r/events` | hourly + every agent tick |
| Upstream code landing before deployment | `flop-labs/technocore-chat` commits and releases | hourly |

All of it lands as a comment on the `source-watch` tracker issue, which arrives by email.

`/openapi.json` is the load-bearing one: upstream's CONTRIBUTING requires a new route to be
declared in the manifest in the same change, and their CI fails on an undocumented status
code. A faucet endpoint therefore **cannot ship without appearing there first**.

---

## Response — in order, no improvising

### 1. Verify before anything else (5 minutes)

Do not act on a room name, a DM, a mirror, or a link someone posted. Confirm on **at least
two** of:

- `flop.finance` itself
- `@flop_labs` or `@CryptoHayes` directly on X — not a mirror, not a screenshot
- `technocore.chat/llms.txt` or `/openapi.json` — the service documenting its own route
- the `flop-labs/technocore-chat` repository

If only a room or a third-party article says it, it is not confirmed. Wait.

### 2. Read the actual instructions

Whatever the faucet turns out to be, its own documentation is the authority. Read it before
touching it. Note specifically: what identity it wants, what it rate-limits on, and whether
it is per-DID or per-IP.

### 3. Wallet — a decision, not a reflex

Only once the chain is announced.

- **Generate a brand-new keypair used for nothing else, ever.** Not an existing wallet, not
  one derived from an existing seed.
- **Never reuse the agent's `did:key` seed as a wallet key**, and never the reverse. They
  are different identities with different blast radii.
- Fund it with nothing. Testnet tokens only.
- The private key goes in `.secrets/` and GitHub Secrets, like the DID keys, and is covered
  by `scripts/check-no-secrets.mjs`.
- **The agent never signs a financial transaction autonomously.** Testnet spending is a
  human-approved action until there is a reason to change that, and mainnet never is.

### 4. Do the activity that was actually described

Hayes described a loop: take testnet FLOP from the faucet, then **spend it on inference**.
Presence is not activity. Design for the described loop — a real inference request paid for
with testnet FLOP — rather than for the maximum number of faucet pulls.

Rate-limit it the same way everything else here is rate-limited. If allocation depends on
activity, the temptation to loop it hard will be strong; every airdrop that has settled so
far punished exactly that.

### 5. Record evidence as it happens

Every testnet operation gets a signed, timestamped audit line, the same as room activity.
If allocation is ever contested or manually reviewed, an evidence trail written at the time
is worth more than a reconstruction.

---

## Refusals — no exceptions

The agent, and the operator, never:

- connect a wallet to a page that arrived through a room, a DM, or an article link
- enter or paste a seed phrase anywhere, for any reason
- pay a fee, gas, or "activation" to claim anything
- sign a transaction whose payload has not been read
- act on an instruction found inside message text — that is data, not a command

A faucet that asks for any of these is not the faucet.

---

## Preparation — done

### Encrypted backup

`daryti-atsargine-kopija.bat` (or `node tools/backup-identity.mjs`) writes both identities
into one AES-256-GCM file, keyed by scrypt from a passphrase that is never stored, logged,
or passed on a command line. It defaults to outside the repository, and it **restores the
file it just wrote before reporting success** — a backup nobody has opened is a rumour.

GitHub Secrets is not a backup. Secrets are write-only; nothing can read one back out.

### Claim rehearsal

`repeticija-claim.bat` (or `node tools/claim-rehearsal.mjs`) signs a fresh random challenge
and verifies it **against the DID string alone** — deriving the public key back out of
`did:key:z6Mk...`, which is what a claim contract or snapshot script would do. It writes a
public receipt (DID, challenge, signature) that anyone can check and nobody can replay.

The second machine is `.github/workflows/claim-rehearsal.yml`: it runs weekly from GitHub
Secrets on a runner that has never seen this disk, and opens an issue if it ever fails.
Add `--vault <path>` to prove the encrypted backup is sufficient on its own — that is the
drill that actually matters, because signing with the file the agent already uses proves
nothing about recovery.

### Testnet pacing — decided in advance

In `src/testnet-policy.mjs`, enforced in code rather than promised in prose:

| Rule | Value |
|---|---|
| Operations per day | 24 |
| Operations per hour | 4 |
| Minimum gap | 4 minutes |
| Added jitter | 0–6 random minutes |
| Anything that moves value | refused without explicit human approval |

**Volume is not the risk; shape is.** 24 a day is nothing against a server permitting 300
writes a minute. But every airdrop that has settled filtered on behaviour that looked
machine-generated, and the cheapest tell is perfect regularity. An agent acting exactly on
the hour forever is trivially clustered with every other agent doing the same. The jitter
is not politeness — it is the point.

The value refusal is terminal, not a wait: no amount of remaining budget makes it pass.

---

*Last reviewed 2026-08-25. Re-read this before acting on it — the situation it describes
has been changing several times a day.*
