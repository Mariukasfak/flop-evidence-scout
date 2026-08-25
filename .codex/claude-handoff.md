# Claude handoff — live council status

Written by Claude (Claude Code session) alongside the in-flight Codex work.
**I have not modified any file owned by the Codex task.** Diagnosis and verified findings only.

Last updated after a real three-agent live run.

## Verified: the council genuinely works for codex + claude

Real `CouncilOrchestrator.run({ prompt: 'Labas', mode: 'live' })`, 74 s, ended `RUN_COMPLETED`:

- both agents proposed, both critiqued each other, real peer scores
  (`claude-proposal 9.9`, `codex-proposal 8.6`)
- delegation resolved to `owner=claude`, `reviewer=codex`
- `degraded: true` only because Gemini failed

Confirmed fixed since my last handoff — thank you:
- Claude CLI arguments (`--tools ''`, no more `--max-turns 1`). Live proposal returns in ~19 s.
- Prompt schema. Claude now returns exactly `summary, approach, bestFit, skills, risks, verification`.
- `ensureSuccess()` surfacing the real reason, and `createSafeEnv()` case-insensitivity.

## OPEN — finding 9: Gemini answers in prose, so every phase is rejected

Gemini fails all three phases (`proposal`, `critique`, `delegation`). The transport is **not** the
problem — the bridge connects, returns a terminal planner response, and health is truthful.

I called `tools/antigravity_council.py` directly with a real `buildProposalPrompt` payload
(11 s, exit 0, conversation `b15814c9-fa18-4d43-b199-d4cafb8d3308`, step_index 4,
`MODEL / PLANNER_RESPONSE / DONE`). Gemini's entire `content` was:

```
Labas! Kuo galiu padėti?
```

Plain prose. `extractJsonObject()` correctly rejects it, which surfaces as
`Provider did not return text containing a valid JSON object`.

So the JSON-only instruction in the shared context does not survive into the Antigravity
planner — it appears to answer in its own conversational agent framing rather than as a
council member. Codex and Claude obey the same prompt, so the prompt text alone is not enough here.

Suggested direction (untested, pick one):
- prepend an explicit, unmissable output contract in the Antigravity request itself rather than
  relying on the shared context block, and/or
- add one bounded repair retry: if `extractJsonObject` fails, re-send within the **same**
  conversation id with "return only the JSON object, no prose" and parse the new terminal step
  (the bridge already supports continuing a conversation via `conversationId`), and/or
- treat a prose answer as a valid low-structure proposal by wrapping it as
  `{ summary: <text> }` instead of discarding the agent entirely.

The third option alone would already stop Gemini from being dropped from every run.

## OPEN — finding 10: the Python bridge corrupts every non-ASCII character

`tools/antigravity_council.py` reads files as UTF-8 but never sets its **stdout** encoding.
On this machine Python's `sys.stdout.encoding` is **`cp1257`**, while Node decodes the pipe as
UTF-8. Every Lithuanian character coming back from Gemini is mangled.

Reproduced with no model call at all — a bare Python script printing `json.dumps` through
`runCommand`:

```
stdout_encoding=cp1257
gauta   : {"t": "pad�ti"}
tiketasi: {"t":"padėti"}
```

The mojibake is visible in real Gemini output too (`Labas! Kuo galiu pad?ti?`).

Fix (Python side, two lines at the top of `main()` / module import — this is the robust place,
because `PYTHONIOENCODING` would be stripped by `createSafeEnv()`'s allowlist):

```python
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
```

This matters beyond Gemini: the bridge is the only Python hop in the system, and the product is
Lithuanian-facing. Note the original Gemini worker brief explicitly warned against introducing mojibake.

## Checks run and results
- Per-file tests at 11:15 (mid-refactor, so treat as a snapshot):
  antigravity-live 4/0, core 14/0, orchestrator 6/**3 fail**, providers 8/**2 fail**,
  server 5/0, web 3/0.
- Live health for all three: `available: true`, `councilAvailable: true`.
- Live Claude proposal through the current `createClaudeProvider`: OK, 19 s, correct schema.
- Full live council run: `RUN_COMPLETED`, `degraded: true` (Gemini only).

## Note on working in parallel
Twice I measured a "bug" that was really a half-written file — `council.mjs` threw
`schema is not defined` for about a minute. Anything I report is re-verified after the file
settles; please do the same with anything you measure in my files.

## Next exact step
1. Apply finding 10 (two lines, no behavioral risk).
2. Apply finding 9 — the wrapper fallback is the smallest change that restores a three-agent council.
3. Re-run a live council; expect `degraded: false` and three proposals.

---

## OPEN — finding 11: the run log cannot be traced back to the real agent sessions

The user noticed that Antigravity fills with visible TriAgent conversations while Codex and
Claude show nothing, and asked why. The three transports persist very differently:

| Agent | Invocation | Persisted? | Visible in its own app? |
|---|---|---|---|
| Gemini | `agentapi new-conversation` | yes, a real Antigravity conversation | **yes** — hence the long sidebar |
| Codex | `codex exec --ephemeral` | **no** — the flag means "run without persisting session files to disk" | no |
| Claude | `claude -p` (headless) | yes, `~/.claude/projects/<project>/<sessionId>.jsonl` | no (print mode is not an interactive session) |

Verified: 18 session files exist for this project, and `052717c4-…jsonl` contains a real council
`Context: {…capabilityProfiles…}` prompt, so council calls really are written to disk.

**The gap:** none of those ids reach the run log.
- `parseClaudeOutput()` returns only `structured_output` / `result` — the envelope's `session_id`
  is dropped on the floor.
- `antigravity-live.mjs` keeps `conversationId` in an in-memory `conversations` Map to continue a
  run's conversation, but never records it as an event.
- The `PROPOSAL` payload is `{ id, agentId, content, checkpointId }` — no provenance field.

So a TriAgent run cannot be linked back to the underlying agent session, which is precisely why
the user is inspecting three vendor sidebars instead of one TriAgent log.

Suggested fix — cheap, and it directly serves the product goal of one followable log:
1. Have each provider return provenance alongside its content, e.g.
   `{ content, trace: { sessionId | conversationId, transport, model, costUsd, durationMs } }`.
2. Record it in the `PROPOSAL` / `CRITIQUE` / `DELEGATION` payloads.
3. Surface it in the UI as a per-agent "source" line.

Claude's JSON envelope already carries `session_id`, `total_cost_usd`, `duration_ms`,
`num_turns` and `modelUsage`; Codex's JSONL and the Antigravity bridge carry equivalents.
This is free telemetry that is currently being discarded.

Related decision for the user, not for me to make unilaterally: whether to drop `--ephemeral`
for Codex so its council turns become resumable. Recording the trace ids is the better first
step either way, because it works without changing any agent's persistence behaviour.

---

# Second audit pass — verified with deterministic tests, no model calls

## OPEN — finding 12 (HIGH): one malformed peer review discards every valid score, and the worst proposal wins

`aggregateScores()` throws on the **first** deviant review. `CouncilOrchestrator` catches that and
falls back to:

```js
ranking = proposals.map((p) => ({ id: p.id, average: 0 })).sort((a, b) => a.id.localeCompare(b.id));
```

So all peer scores from all agents are thrown away and the winner becomes whichever proposal id
sorts first alphabetically. With the current ids that is **always `claude-proposal`**
(`claude-` < `codex-` < `gemini-`).

Demonstrated with a clean fixture where the peers rated Claude worst:

```
clean ranking : codex-proposal 9 | gemini-proposal 8 | claude-proposal 2
+ one bad review (a hallucinated 'sonnet-proposal')
  -> aggregateScores throws
  -> fallback  : claude-proposal 0 | codex-proposal 0 | gemini-proposal 0
  -> WINNER    : claude-proposal, rated 2/10 by its peers
```

Every one of these ordinary LLM deviations triggers it — each tested individually:

| deviation | result |
|---|---|
| a score of 11 | destroys the whole ranking |
| a score of `null` | destroys the whole ranking |
| one rubric dimension missing | destroys the whole ranking |
| one extra dimension (`speed`) | destroys the whole ranking |
| an agent reviewing itself | destroys the whole ranking |
| no `scores` field at all | destroys the whole ranking, as a raw `TypeError: Cannot convert undefined or null to object` |

This is silent: the run still ends `RUN_COMPLETED`, and the only trace is
`degradedReasons: ['peer_ranking_invalid']` plus one ERROR event. The user sees a confident
winner with score `0.00` — which is exactly what their screenshot showed.

It is also amplified downstream: `validateDelegation(..., { expectedOwner: owner })` forces the
conductor's delegation to match the ranking, so a collapsed ranking overrides the conductor's
own judgement rather than being corrected by it.

**Suggested fix:** make aggregation resilient per review instead of all-or-nothing. Validate each
review independently, skip and log the invalid ones, and aggregate the rest. Only fall back to the
zero ranking when *no* valid review survives. A single agent's formatting slip must not be able to
decide who wins.

## OPEN — finding 13 (MEDIUM): duplicate sequence numbers silently hide events from the live view

`RunStore` caches the next sequence number in a per-instance `seqMap` and only recovers it from
disk when that cache is cold. Two instances pointed at the same run therefore both hand out the
same numbers. Reproduced exactly:

```
seq: 1:RUN_CREATED  2:PROPOSAL  3:PROPOSAL  3:CRITIQUE  4:FINAL
duplicates: yes
what the browser renders over SSE: RUN_CREATED, PROPOSAL, PROPOSAL, FINAL
silently lost: 1 event (the CRITIQUE)
```

The loss happens in `streamRunEvents()`, which advances with `event.seq > lastSeq` — a repeated
number is filtered out and never reaches the page. Nothing errors; the critique simply never appears.

A corrupt-but-parseable last record does the same thing: a record whose `seq` is not a number makes
`appendEvent()` silently restart numbering at 1 (`if (typeof seq !== 'number') seq = 0`), which
contradicts the "fail loudly on a corrupt log" rule that the rest of the file follows.

**Suggested fix:** derive the sequence from the file under an exclusive append, or at minimum
re-read the tail on every append; and throw on a non-numeric `seq` instead of resetting to 0.

## OPEN — finding 14 (LOW): falsy agent ids bypass validation

`appendEvent()` guards with `if (event.agentId && !isValidAgent(event.agentId))`. Because the check
is truthiness-based, `agentId: ''` and `agentId: 0` skip validation entirely and are written to the
append-only log. Verified: both were accepted and stored. Use `agentId !== undefined` (or an
explicit `'agentId' in event`) instead.

## Tested and NOT a bug
Windows reserved device names (`CON`, `NUL`, `PRN`, `COM1`, `aux`) pass `validateRunId`, but I
verified that `createRun('NUL')` writes and reads back correctly through the full path, so this is
not exploitable here. Recording it so nobody re-investigates it.

---

# Protocol proposal — please read before extending the pipeline

Wrote **`docs/SVARSTYMO-PROTOKOLAS.md`** (Lithuanian, matching the other docs). It is meant as the
shared contract for all three agents: change the document first, then the code. It covers the
second deliberation round, the execution gate, effort tiers//budget, log conventions, and a
self-calibration loop. Summary of what it asks for, plus one new finding:

## OPEN — finding 15 (HIGH, safety): execution starts on a keyword guess, not on consent

`CouncilOrchestrator.run()` enters the EXECUTION phase automatically whenever `isCodeTask(prompt)`
is true. That predicate is a substring match:

```js
lower.includes('sukurk kod') || lower.includes('parašyk kod') || lower.includes('implement')
  || lower.includes('refactor') || lower.includes('programuoti') || lower.includes('kodo')
```

`implement` matches an enormous amount of ordinary English text, and `kodo` matches many Lithuanian
phrases that are not requests to change anything. So a keyword decides whether the system starts
acting on the machine.

This also contradicts the project's own stated rule, which every FINAL payload repeats verbatim:
*"Council consensus is advisory and does not grant computer permissions."* A heuristic is not consent.

**Proposed fix (section 3 of the protocol doc):** the council always stops at DELEGATION. The UI
renders the plan (owner, reviewer, assignments, files, verification) with a `Vykdyti planą` button.
EXECUTION starts only after an explicit `EXECUTION_APPROVED` event. Keep `isCodeTask()` as a
pre-selection hint for the button, not as the trigger.

## The second round (protocol section 2), in short

New PATIKSLINIMAS phase between CRITIQUE and the decision. Each agent receives every proposal plus
the critiques aimed at its own, and returns either a revised proposal (`changed: true`, with a
`changeLog`) or a reasoned defence (`changed: false`, with `defense`). Only revised proposals are
re-scored, so the cost scales with how much actually changed.

It is gated so it does not run on easy tasks: top-two gap < 0.75, or any cross-score below 5, or any
proposal that needed the repair retry, or an explicit deep effort level. Otherwise log
`refine_skipped` with the reason. Exactly one round, never a loop to consensus.

## Dependencies on earlier findings
Section 4 (cost accounting) needs finding 11 (trace ids are currently discarded).
Section 6 (self-calibration) needs finding 12 fixed first, otherwise the measured win rates are
contaminated by the alphabetical fallback that always elects `claude-proposal`.

---

# APPLIED BY CLAUDE — files I changed

I only touched files that had been untouched by the Codex task for a long time, to avoid the
parallel-editing problem. `council.mjs` and `orchestrator.mjs` were being actively rewritten, so
findings 12 and 15 are **still open and still yours**.

## Fixed: finding 10 + a much worse variant of it — `tools/antigravity_council.py`

You had already added the `sys.stdout/stderr/stdin.reconfigure(encoding="utf-8")` block, so I
removed the duplicate I had started adding. But the real damage was one level deeper.

All three `subprocess.run(..., text=True)` calls decoded the agentapi output with the console
codepage. On this machine that is **cp1257**, so any non-ASCII byte crashed the bridge:

```
File ".../subprocess.py", line 1599, in _readerthread
File ".../encodings/cp1257.py", line 23, in decode
UnicodeDecodeError: 'charmap' codec can't decode byte 0xa1 in position 85
Antigravity bridge error: the JSON object must be str, bytes or bytearray, not NoneType
```

**Typing a single Lithuanian letter into TriAgent killed the Gemini agent outright.** Verified:
prompt `Atsakyk viena eilute lietuviskai.` (pure ASCII) succeeded, while
`Ačiū, ar gali padėti šiandien?` failed every time.

Fix: `encoding="utf-8", errors="replace"` on all three calls. Verified live end to end:

```
exit = 0
Gemini atsake: Ačiū, galiu padėti šiandien.
mojibake: none | Lithuanian letters present: yes
```

## Fixed: findings 13 + 14 — `src/core/run-store.mjs`

That file had not been modified since 10:13, so I took it.

- The sequence number is now always read from disk (`readLastSeq()`), never from the per-instance
  cache. Two stores writing one run now produce `1,2,3,4,5` instead of `1,2,3,3,4`, so the SSE
  filter no longer silently swallows an event.
- A last record whose `seq` is not a non-negative integer now throws
  `Corrupt run log: last record has an invalid seq (...)` instead of quietly restarting at 1.
- `event.agentId !== undefined` replaces the truthiness check, so `''`, `0` and `null` are rejected.
  Events with no `agentId` key remain legal.

Cost of the change: one tail read per append instead of a cached counter. Runs are tens of events,
so this is negligible, and correctness matters more here than the micro-optimisation.

## New tests (both green, additive, no existing file touched)
- `test/run-store-integrity.test.mjs` — 3 tests, one per fixed defect above.
- `test/bridge-encoding.test.mjs` — 2 cheap source-invariant guards so the encoding settings cannot
  quietly disappear in a future refactor.

## Test state when I finished
```
antigravity-live 5/0   bridge-encoding 2/0   connection-check 1/0   core 17/1
learning-registry 5/0  orchestrator 12/1     providers 10/0         run-store-integrity 3/0
server 2/4             web 1/2
```
The remaining failures are yours in progress, not regressions from my changes: `core` fails only on
`council uses conservative learned priors only as a bounded tie influence`, and `server`/`web` fail
on the demo-mode removal (tests expect 400 for demo, the app still returns 202). I re-ran them
before and after my edits and the same set failed both times.

## Final state (updated after Codex finished the demo-mode removal)

Everything is green. The earlier red numbers in the section above were your work in progress and
are now resolved:

```
antigravity-live 5   bridge-encoding 2   connection-check 1   core 18
learning-registry 7  orchestrator 13     providers 10         run-store-integrity 3
server 6             web 3
TOTAL: 68 passed, 0 failed
```

Also added `tools/testu-suvestine.mjs` plus `patikrinti-testus.bat`: a compact one-line-per-file
test summary, because `npm test` dumps multi-kilobyte assertion diffs that are unreadable for the
user. It has a 120 s per-file timeout so one hanging suite cannot block the whole report.

Still open and still yours, both in files you were actively rewriting:
- **finding 12** (one malformed review collapses the ranking; the alphabetical fallback always
  elects `claude-proposal`)
- **finding 15** (EXECUTION starts on the `isCodeTask()` keyword guess rather than on consent)
- **finding 9** (Gemini answers in prose) and **finding 11** (trace ids discarded)
