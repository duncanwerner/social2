# Round generation — validation findings

**Subject:** `NextRound` in [`src/social.ts`](src/social.ts) — the optimizer behind
the rounds page's **+ Next round** / **Regenerate** buttons.
**Validator:** [`scripts/validate-rounds.ts`](scripts/validate-rounds.ts) — `npm run validate:rounds`.
**Recorded:** commit `37916c2`, on a full-suite run with `--seed 1`.

This doc records what the validator found, what it deliberately verifies as *good*,
and the quirks worth knowing before touching the generator. Nothing here is fixed
yet — RG-1 and RG-2 are open.

## TL;DR

The generator's **distribution** is healthy: sit fairness, partner uniformity on the
first round, repeat-avoidance and the whole-session behaviour all pass. But it has a
**crash-class defect on inputs the UI can produce today**, and no UI guard prevents
those inputs. `npm run validate:rounds` is red for that reason alone.

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| **RG-1** | High (crash / data corruption) | **open** | `NextRound` returns `undefined` when more than half the pool must sit, despite being typed `InstrumentedRound` |
| **RG-2** | Medium (UX, feeds RG-1) | **open** | Nothing stops the user generating a round that cannot be played: the Sit checkboxes and court count have no minimum-players guard |
| **RG-3** | Low (misleading data) | **open** | The first-round fast path reports hard-coded zero metrics instead of measured ones |
| **RG-4** | Low (testability) | **open** | The RNG is `() => Math.random()`, not injectable; the validator has to monkey-patch the global |
| **RG-5** | Info (trap, not a bug) | — | Team hashes sort **lexicographically**, so `[2,10]` hashes as `"10,2"` — consistent, but surprising |
| **RG-6** | Info (perf) | — | Candidate count is `2500 + 2000 × (players − 12)`; cost grows to ~115 ms/call at 20 players |

## How the generator decides

`NextRound` samples `n` random candidate rounds (`RandomRound`: shuffle the pool,
fill courts four at a time, the remainder sit), scores each one, then picks the best
in two passes before returning the first survivor:

1. **Keep the fewest over-sat players** (minimum `max_sitting_count`), and *discard
   any candidate where a sitter also sat in the most recently played round*.
2. Among those, minimise repeated teams, then maximise how long ago a repeated team
   last played, then minimise repeated opponents.

Pass 1 is where RG-1 lives.

## Reproducing

```bash
cd frontend
npm run validate:rounds                 # full suite (~16 s), exits 1 while RG-1 is open
npm run validate:rounds -- --quick      # ~9 s
npm run validate:rounds -- --no-edge    # distribution checks only: exits 0 today
npm run validate:rounds -- --verbose    # show detail lines for passing checks too
npm run validate:rounds -- --json       # machine-readable report
npm run validate:rounds -- --file ../lib/sample-event.json
```

`--strict` promotes warnings to failures; `--seed <n>` makes a run reproducible.

---

## RG-1 — `NextRound` can return `undefined`

**Severity:** high. **Status:** open.

### What happens

`filtered` is built only from candidates whose sitters avoid the most recently played
round. When more than half the available pool must sit, **every** candidate round must
re-seat someone who sat last time, so `filtered` ends up empty and `filtered[0]` is
`undefined` — even though the function is typed as returning `InstrumentedRound`.

Precisely: let `n` = players available (pool minus `force_sitting`), `k` = how many of
them must sit, and `R` = the players who sat in the previous round. A candidate is
acceptable iff a `k`-subset disjoint from `R` exists, i.e. `n − |R| ≥ k`; once
`k + |R| > n` no candidate survives. In the steady state `|R| = k`, so the trigger is
simply **`k > n/2` — more than half the pool sits**.

### Evidence

Single court, varying pool size (20 calls each; verified):

| pool | sitters `k` | result |
|------|-------------|--------|
| 5 players | 1 | fine |
| 6 players | 2 | fine |
| 7 players | 3 | fine |
| 8 players | 4 (exactly half) | fine |
| 9 players | 5 | **`undefined` 20/20** |
| 10 players | 6 | **`undefined` 20/20** |
| 12 players | 8 | **`undefined` 20/20** |

Also reproduced: 10 players / 3 courts with 7 forced to sit **and one of the three
remaining players having sat in the previous round** → `undefined` 20/20. 3 players /
1 court → `undefined` 25/25. 4 players / 0 courts with a history in which all four sat
→ `undefined` 20/20. `n < 4` and `courts = 0` are just the `k = n` extreme.

The validator carries two of these as permanent regression cases: *EDGE 10 players / 1
court (6 must sit)* and *DEGENERATE 3 players / 1 court*.

### Why it reaches users

Both triggers are reachable from the UI:

- **Court count** is a free choice in the event editor — a social with 10 players and
  1 court is a perfectly ordinary thing to set up.
- **Sit checkboxes** (`EventEditor` → `Player.disabled`) fold into `force_sitting` in
  `src/round-worker.ts`. Disabling players until 3 remain is a normal thing to do when
  people drift away.

The **+ Next round** button is guarded only by `generating() || !isLastRound()`
(`src/routes/view/[id]/rounds.tsx:440`) — there is no check on active players or court
count.

### Impact

`src/social-worker.ts` pushes the result straight into its accumulator:

```ts
const round = NextRound(data.players, data.courts, rounds, data.options);
rounds.push(round);   // may push undefined
```

The array is posted back to the main thread, and `generate()` saves it as
`record.data.rounds`. `JSON.stringify` turns the hole into `null`, so the record
**persists a null round**. Downstream, `.matchups` is dereferenced without a guard in
at least two places:

- `src/standings.ts:59` — `for (const m of round.matchups)` ⇒ the **Stats tab throws**.
- `src/routes/view/[id]/rounds.tsx:169` — `r.matchups.map(...)` in
  `eventWithDraftScores()`, which runs on generate/regenerate/save-scores whenever the
  null round is the viewed one.

(A runtime error in a Solid render is exactly the failure mode the root `CLAUDE.md`
warns blanks the screen, so this is worth taking seriously rather than filing as
cosmetic.)

### Suggested fix (not applied)

The pass-1 comment already states the intent — *"we also don't want anyone sitting
twice in a row, **unless absolutely necessary**"* — but the code treats it as a hard
filter. Two options:

1. **Fallback (minimal, matches the stated intent):** if the strict filter yields
   nothing, fall back to the best candidate that only violates the back-to-back rule,
   e.g. keep pass-1's `max_sitting_count` ordering and take `rounds[0]` when `filtered`
   is empty. The generator then always returns a legal round, and a repeat sit happens
   only when it is genuinely unavoidable.
2. **Make the contract honest:** return `InstrumentedRound | undefined` and handle it
   at the worker boundary — but that only relocates the problem unless paired with
   option 1 or a guard in RG-2.

Whoever fixes it should also decide the intended behaviour for a pool that cannot fill
a single court (`n < 4`, or `courts = 0`), which today yields an all-sit round (see
RG-2).

---

## RG-2 — nothing guards an unplayable round

**Severity:** medium. **Status:** open. **Related:** RG-1.

With 10 players / 3 courts and 7 disabled, generation *succeeds* but returns a round
in which **all ten players sit and no court is filled**. The validator reports this as
`diversity: no courts could be filled (every player sits), so there is nothing to
vary` — a legal round, just a useless one.

So there are two outcomes for the same class of input, depending on history:

- if any of the remaining players sat in the previous round → `undefined` (RG-1);
- otherwise → an all-sit round that still gets persisted and broadcast to viewers.

Neither is what a user pressing **+ Next round** wants. A guard would fix both: disable
the button (with an explanatory message) when no court can be filled, or when the
resulting sit load exceeds half the pool. With
`active` = active players and `fours = min(floor(active / 4), courts)`, that is
`fours < 1`, or `active − 4 × fours > active / 2` (the RG-1 trigger).

## RG-3 — the first-round fast path reports fake metrics

**Severity:** low. **Status:** open.

`NextRound` short-circuits when there is no history and returns hand-written zeros:

```ts
max_repeat_opponents: 0, max_sitting_count: 0, max_repeat_teams: 0,
min_repeat_team_delta: 0, min_sitting_delta: 0,
```

For a `Round 1` that seats 8 of 10 players, `max_sitting_count: 0` and
`min_sitting_delta: 0` are simply false (a recount says 1 and −1). No code outside
`social.ts` reads these fields today (verified by grep), so the impact is latent — but
any UI affordance, export or analytics that reads `InstrumentedRound` metrics will be
wrong for the first round specifically. Either compute the real metrics on that path
(the counting code is already below it) or narrow the type so the fields are documented
as meaningless for the fast path.

The validator therefore **skips the metric-recount comparison when the history is
empty**, and says so in the code — that exemption is a consequence of this finding, not
an oversight.

## RG-4 — the RNG is not injectable

**Severity:** low. **Status:** open.

`const RNG = () => Math.random();` (social.ts, "placeholder for a better RNG"). Because
the indirection is module-private, `validate-rounds.ts` has to replace the global
`Math.random` with a seeded generator (mulberry32) for the duration of a run, then
restore it. That works, but it is a blunt instrument: it makes the harness
order-dependent and would break if generation ever moved to a worker-local RNG.
Threading an optional `rng` through `NextRound`/`RandomRounds` (defaulting to
`Math.random`) would let runs be seeded honestly, and is a prerequisite for turning any
of this into a deterministic `npm test`.

## RG-5 — team hashes sort lexicographically

**Severity:** info — **not a bug**, but a trap.

`social.ts` hashes teams with `[...team].sort().join(",")`. The default comparator
sorts as strings, so a team of players `2` and `10` hashes as `"10,2"`. This is
*consistent* — both the write and the lookup use the same expression, so repeat
detection is correct, including for pools above 9 players (verified: the
`max_repeat_teams` recount agrees with the optimizer in every trial tested). The trap
is that the hash is not numerically ordered, so anything that builds the same key a
different way (e.g. `[...team].sort((a, b) => a - b)`) will silently fail to match.
`validate-rounds.ts` uses the identical expression on purpose and comments why.

## RG-6 — candidate cost scales linearly with pool size

**Severity:** info.

`const n = 2500 + Math.max(0, players.length - 12) * 2000;` — measured on this machine:

| pool | candidates | cost/call |
|------|-----------|-----------|
| 8–10 players | 2 500 | ~6 ms |
| 13 players | 4 500 | ~17 ms |
| 16 players | 10 500 | ~52 ms |
| 20 players | 18 500 | ~115 ms |

Generation runs in a Web Worker per call, so this is acceptable for the expected social
size, and it is the knob to turn if large socials ever feel slow. Note that the cost is
paid per *candidate* (each `RandomRound` also mints a `crypto.randomUUID()` per
matchup), so a bigger pool costs disproportionately more than the extra players alone.

---

## Verified-good behaviour (baseline)

These are the properties the validator asserts and currently confirms. They are the
part that makes a future regression visible, so please keep them green.

- **Structure (all 16 samples).** Every returned round is a legal partition: disjoint
  fours, at most one game per player, `force_sitting` honoured and never on court, fresh
  `[-1,-1]` scores, unique matchup ids, and instrumentation that matches an independent
  recount.
- **Sitting fairness across a social.** With sessions simulated round by round from a
  clean slate, the per-player sit spread was ≤ 1 in **every** session of every sample
  (8/8 sessions in the 8-round samples), which is the theoretical optimum.
- **Nobody sits twice in a row.** 0 back-to-back sits across 64 rounds per sample, and
  `min_sitting_delta === 0` in 0/200 trials on the history-bearing samples.
- **First-round shuffle is unbiased.** Partner draws are uniform for every player
  (worst χ² 24.6 against a critical 49.5 at df 18 for 20 players; all samples pass at
  α = 0.0001, Bonferroni-corrected).
- **The optimizer is a real improvement over random.** Repeated-team slots per 8-round
  session: **0.00 vs 9.04** (10 players / 3 courts), **0.00 vs 13.68** (12 players),
  **4.00 vs 12.12** (8 players / 2 courts, where repeats are unavoidable). Repeats are
  unavoidable in a few configurations; the optimizer stays at or near the floor.
- **Optimality is pinned, not scattered.** On history-bearing samples `max_repeat_teams`
  and `max_sitting_count` sit at the best value seen in **200/200** trials with spread
  0 — the metrics converge even though the returned schedule varies.
- **Diversity is high where it should be, and low where low is correct.** Fresh 10
  players / 3 courts: 378/400 distinct rounds. With 6 rounds of history: 25/200 distinct,
  commonest answer 31× — expected, because the optimizer converges on the few optimal
  rounds, so a repeated answer there is correct behaviour rather than a stuck RNG.
- **Generation does not mutate its inputs.** The caller's history array is unchanged
  after each call (checked per trial).

Measured numbers depend on seed and machine; the assertions do not. `--seed 1` is the
default so a re-run reproduces the table above.

## What the validator checks, and why it is built this way

| check | method |
|-------|--------|
| `structure` | per-round invariants + an **independent re-implementation** of the metric counting (`measure()`), written from the spec rather than copied, so drift between what the optimizer reports and the round it returns is caught. Verified live by deliberately perturbing it. |
| `robustness` | counts `undefined` returns; a hard failure on inputs the UI can reach, a warning on inputs where no legal round exists. |
| `shuffle` | with no history, each player's partner is uniform over the pool, so a per-player χ² (df = pool − 2, α = 0.0001 Bonferroni-corrected, Wilson–Hilferty critical value) detects a biased shuffle. |
| `quality` | with history, asserts `min_sitting_delta === 0` never happens and that `max_sitting_count` / `max_repeat_teams` hit the best observed value in ≥ 95 % of trials. |
| `session` | generates a whole social round by round from an empty history, then asserts sit spread ≤ 1, zero back-to-back sits, and fewer repeat-team slots than a naive shuffle scheduler averaged over 25 runs. Cumulative spread including the sample's own history is reported but not asserted, since the optimizer can only reduce inherited imbalance. |
| `diversity` | distinct canonical rounds (partner pairs + sitting set), Shannon entropy, commonest-answer count. Fails outright on a single repeated answer; warns on hard clustering. |

Two deliberate semantics worth remembering: sessions start from an **empty** history
(so the fairness assertion is clean), and `force_sitting` players are excluded from both
the mirror's `min_sitting_delta` and the session balance check, because `instrument()`
measures a candidate *before* re-appending forced sitters — and forced players are
supposed to sit every round.

## Adding a sample

Add a `Sample` to `builtInSamples()` in `scripts/validate-rounds.ts`, or pass
`--file`. Both sample shapes are accepted:

- legacy `lib/sample-event.json` — `{ "players": [0,1,…], "courts": 3, "rounds": [...], "player_names": [...] }`
- `SocialEvent` from `src/types.ts` — `{ "players": [{ "id": 0, "name": "…", "disabled": true }], "courts": [...], "rounds": [...] }`

For the `SocialEvent` shape the loader mirrors `round-worker.ts` and folds `disabled`
players into `force_sitting`, so a sample reproduces what the app actually sends.
