# Round generation — validation findings

**Subject:** `NextRound` in [`src/social.ts`](src/social.ts) — the optimizer behind
the rounds page's **+ Next round** / **Regenerate** buttons, and the seeded fill
behind **Edit round manually**.
**Validator:** [`scripts/validate-rounds.ts`](scripts/validate-rounds.ts) — `npm run validate:rounds`.
**Recorded:** commit `37916c2`, on a full-suite run with `--seed 1`.
**Updated:** manual round editing — `NextRound` now takes an optional `RoundSeed`,
and RG-1 is fixed (see below). `npm run validate:rounds` is green.

This doc records what the validator found, what it deliberately verifies as *good*,
and the quirks worth knowing before touching the generator.

## TL;DR

The generator's **distribution** is healthy: sit fairness, partner uniformity on the
first round, repeat-avoidance and the whole-session behaviour all pass. The one
crash-class defect it found on inputs the UI can produce today (**RG-1**) is now
fixed, and the manual-edit fill path it enabled is covered by a `seed` check. The
suite exits 0.

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| **RG-1** | High (crash / data corruption) | **fixed** | `NextRound` used to return `undefined` when more than half the pool must sit; it now falls back to the best candidate |
| **RG-2** | Medium (UX, feeds RG-1) | **open** (narrowed) | Still nothing stops **+ Next round** from generating an all-sit round (10 players / 3 courts with 7 disabled). The crash is gone, but the round is still useless; the manual editor reports its own version of this |
| **RG-3** | Low (misleading data) | **open** | The first-round fast path reports hard-coded zero metrics instead of measured ones |
| **RG-4** | Low (testability) | **open** | The RNG is `() => Math.random()`, not injectable; the validator has to monkey-patch the global |
| **RG-5** | Info (trap, not a bug) | — | Team hashes sort **lexicographically**, so `[2,10]` hashes as `"10,2"` — consistent, but surprising |
| **RG-6** | Info (perf) | — | Candidate count is `2500 + 2000 × (players − 12)`; cost grows to ~115 ms/call at 20 players |

## How the generator decides

`NextRound` samples `n` random candidate rounds (`RandomRound`: shuffle the pool, fill
courts four at a time, the remainder sit), scores each one, then picks the best in two
passes before returning the first survivor:

1. **Keep the fewest over-sat players** (minimum `max_sitting_count`), and *discard any
   candidate where a sitter also sat in the most recently played round* — unless no such
   candidate exists, in which case the best survivor of the first rule is used (see RG-1).
2. Among those, minimise repeated teams, then maximise how long ago a repeated team last
   played, then minimise repeated opponents.

With a `RoundSeed`, `RandomRound` starts from the caller's court layout instead of a bare
shuffle — committed courts are completed first, open courts get fresh games, and a court
the pool cannot complete is dropped. Everything after that is unchanged, so the same two
passes score seeded and unseeded candidates alike (see below).

## Reproducing

```bash
cd frontend
npm run validate:rounds                 # full suite (~16 s), exits 0 today
npm run validate:rounds -- --quick      # ~9 s
npm run validate:rounds -- --no-edge    # distribution checks only
npm run validate:rounds -- --verbose    # show detail lines for passing checks too
npm run validate:rounds -- --json       # machine-readable report
npm run validate:rounds -- --file ../lib/sample-event.json
```

`--strict` promotes warnings to failures; `--seed <n>` makes a run reproducible.

---

## RG-1 — `NextRound` can return `undefined` (fixed)

**Severity:** high. **Status:** fixed. **Was:** open at `37916c2`.

### What happened

`filtered` was built only from candidates whose sitters avoid the most recently played
round. When more than half the available pool must sit, **every** candidate round has to
re-seat someone who sat last time, so `filtered` ended up empty and `filtered[0]` was
`undefined` — even though the function is typed as returning `InstrumentedRound`.

Precisely: let `n` = players available (pool minus `force_sitting`), `k` = how many of
them must sit, and `R` = the players who sat in the previous round. A candidate is
acceptable iff a `k`-subset disjoint from `R` exists, i.e. `n − |R| ≥ k`; once
`k + |R| > n` no candidate survives. In the steady state `|R| = k`, so the trigger was
simply **`k > n/2` — more than half the pool sits**.

### Evidence (before the fix)

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
→ `undefined` 20/20.

The validator carries two of these as permanent regression cases: *EDGE 10 players / 1
court (6 must sit)* and *DEGENERATE 3 players / 1 court*.

### Why it reached users

Both triggers are reachable from the UI:

- **Court count** is a free choice in the event editor — a social with 10 players and
  1 court is a perfectly ordinary thing to set up.
- **Sit checkboxes** (`EventEditor` → `Player.disabled`) fold into `force_sitting` in
  `src/round-worker.ts`. Disabling players until 3 remain is a normal thing to do when
  people drift away.

It also made the manual-edit fill path unsafe: a seed that commits players to courts
shrinks the pool the "nobody sits twice" filter can work with, so the empty-`filtered`
case is easy to hit with a hand-built layout.

### Fix applied

Pass 1 now keeps the min-`max_sitting_count` set (`acceptable`) and computes the
back-to-back-sit filter over it; if that filter yields nothing, pass 2 sorts and returns
the best of `acceptable` instead of dereferencing an empty array:

```ts
const filtered = acceptable.filter(r => r.min_sitting_delta === -1 || r.min_sitting_delta > 0);
const candidates = filtered.length ? filtered : acceptable;
```

This is exactly the "unless absolutely necessary" intent the original comment stated. It
only changes behaviour on inputs where no legal alternative exists, so every distribution
baseline below is unchanged; the EDGE/DEGENERATE samples now return a legal round rather
than `undefined`, and `structure` / `robustness` pass for all 16 samples.

`qualityFinding` in the validator gained the matching exemption: the back-to-back-sit
rule is asserted only when `n − |R| ≥ k`, i.e. when a round that avoids it actually
exists. Otherwise it says so in the details rather than failing the input.

### Still open: RG-2

With RG-1 fixed, the crash is gone, but the **+ Next round** button can still produce an
all-sit round (10 players / 3 courts with 7 disabled). Nothing guards that yet.

---

## Manual round editing — `RoundSeed`

**Since:** the **Edit round manually** control on the rounds page (owner-only, newest
unscored round). **Validated by:** the `seed` check.

The optimistic path (RG-2) leaves the owner with a bad automatic round; the manual path
lets them fix it. The owner assigns players to court slots, and any slot they leave open
is filled by the optimizer:

```ts
export interface RoundSeed {
  matchups: PartialMatchup[];   // positional: matchups[i] is court i, slots may be null
}

NextRound(players, courts, previous_rounds, options, seed?)
```

Contract, in the order the code applies it:

1. **The roster wins.** A seeded player who is absent, unknown, or forced to sit (the
   Sit checkbox) is cleared from their slot before anything else — a manual pick can't
   override `force_sitting`. A player seeded into two courts is kept only in the first.
2. **Seeded players leave the pool**, so the filler can never give them a second game or
   move them.
3. **Courts are positional.** `matchups[i]` describes court `i`, and an all-empty entry
   is a court the caller left open. The editor always passes one entry per configured
   court, which is what lets it put a completed matchup back on the court number the
   owner assigned.
4. **Committed courts are completed first** (most fixed players first), so a half-filled
   court can't be starved by an empty court listed above it. Ties keep court order.
5. **A court the remaining pool cannot complete is dropped**, and whoever was assigned
   to it sits. The editor detects this and tells the owner which courts were affected.
   New games are only created on courts the caller left open, and only while a full four
   remains.

The `seed` check in `validate-rounds.ts` pins this down over five scenarios (a complete
court kept together, two half-courts completed in place, a starved court dropped, the
RG-1 input with a seeded court, and a malformed seed with repeated slots). Each fill is
asserted to be a legal partition of the pool with the seeded players exactly where they
were put, the caller's seed unchanged, and `undefined` never returned.

---

## RG-2 — nothing guards an unplayable round

**Severity:** medium. **Status:** open (narrowed by the RG-1 fix). **Related:** RG-1.

With 10 players / 3 courts and 7 disabled, generation *succeeds* but returns a round
in which **all ten players sit and no court is filled**. The validator reports this as
`diversity: no courts could be filled (every player sits), so there is nothing to
vary` — a legal round, just a useless one.

Before the RG-1 fix there were two outcomes for the same class of input, depending on
history: `undefined` if any of the remaining players sat in the previous round, an
all-sit round otherwise. Only the second remains — the crash is gone, the useless round
is not.

A guard would fix it: disable the button (with an explanatory message) when no court can
be filled, or when the resulting sit load exceeds half the pool. With
`active` = active players and `fours = min(floor(active / 4), courts)`, that is
`fours < 1`, or `active − 4 × fours > active / 2`. The manual editor already refuses to
open for an event with no courts, and its **Fill remaining** reports any court it could
not complete — but **+ Next round** still has no equivalent check.

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
- **Seeded fills honour the manual assignment.** Across five scenarios (400 fills on a
  default run) every seeded player ends up exactly where the owner put them or sitting
  (if their court could not be completed), the result is a legal partition of the pool,
  and the caller's seed is unchanged.

Measured numbers depend on seed and machine; the assertions do not. `--seed 1` is the
default so a re-run reproduces the table above.

## What the validator checks, and why it is built this way

| check | method |
|-------|--------|
| `structure` | per-round invariants + an **independent re-implementation** of the metric counting (`measure()`), written from the spec rather than copied, so drift between what the optimizer reports and the round it returns is caught. Verified live by deliberately perturbing it. |
| `robustness` | counts `undefined` returns; a hard failure on inputs the UI can reach, a warning on inputs where no legal round exists. |
| `shuffle` | with no history, each player's partner is uniform over the pool, so a per-player χ² (df = pool − 2, α = 0.0001 Bonferroni-corrected, Wilson–Hilferty critical value) detects a biased shuffle. |
| `quality` | with history, asserts `min_sitting_delta === 0` never happens (except where no such round exists) and that `max_sitting_count` / `max_repeat_teams` hit the best observed value in ≥ 95 % of trials. |
| `session` | generates a whole social round by round from an empty history, then asserts sit spread ≤ 1, zero back-to-back sits, and fewer repeat-team slots than a naive shuffle scheduler averaged over 25 runs. Cumulative spread including the sample's own history is reported but not asserted, since the optimizer can only reduce inherited imbalance. |
| `diversity` | distinct canonical rounds (partner pairs + sitting set), Shannon entropy, commonest-answer count. Fails outright on a single repeated answer; warns on hard clustering. |
| `seed` | fills a `RoundSeed` and asserts the manual round-editing contract: seeded players stay in their slots (or sit if their court is dropped), no duplicates, every active player accounted for exactly once, fresh scores/ids, `force_sitting` honoured, and the caller's seed not mutated. |

The `quality` rule is asserted only when a round avoiding a back-to-back sit actually
exists: with `n` active players, `k` of them sitting and `|R|` of them having sat last
round, that means `n − |R| ≥ k`. RG-1's fallback otherwise has no choice but to re-seat
someone, so failing the input would be wrong.

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
