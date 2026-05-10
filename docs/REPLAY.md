# Replay determinism

TCGVibes records and replays games through a small command stream
([`src/engine/gameCommands.ts`](../src/engine/gameCommands.ts)) plus a
schema-versioned wrapper ([`src/engine/replay.ts`](../src/engine/replay.ts)).
This doc captures the determinism contract — what is and isn't guaranteed,
and how the loader behaves at version mismatches.

## Recording

Live games append a `GameCommand` to the in-flight `GameReplay.commands` ONLY
after the engine returns `ok: true`. Failed actions are never persisted —
the recorded stream represents the game that actually happened, not the one
the player tried to make happen.

The header captured at game start:

```ts
{
  schemaVersion: 2,           // current; bump policy below
  appVersion,                 // src/version.ts → APP_VERSION
  dataVersion,                // src/data/cards.ts → datasetAsOf
  createdAt,                  // ISO timestamp
  initial: {
    p1CardIds, p2CardIds,     // resolved Card.id arrays in deck-build order
    rngSeed,                  // single seed; per-command RNG is NOT recorded
    setupOptions,
  },
  commands: [],
  // Populated when the engine reaches phase=gameOver. Absent on in-flight
  // replays and on v1 replays loaded by a v2 build.
  outcome?: {
    winner: PlayerId | null,  // null covers aborted / draw endings
    completedAt,              // ISO timestamp at finalization
    gameMode: "vsCPU" | "local",
  },
}
```

Per-command RNG state is intentionally NOT recorded. Storing it would create
a desync risk: if the engine ever reorders RNG calls inside an action, the
per-command state becomes stale, while the seed-driven path remains
deterministic against the same engine version.

## Determinism contract

A replay reproduces the original game **only against the same engine code
path AND the same card dataset**. Specifically:

- **Same `appVersion`**: replay works fully. Engine code paths match;
  RNG ordering matches; card behavior matches.
- **Different `appVersion`**: replay LOADS but emits a warning. Behavior
  may differ if the engine reorders RNG calls or changes how an action
  consumes randomness.
- **Different `dataVersion`**: replay LOADS but emits a warning. Card text,
  HP, attack cost, ability behavior may have changed in ways that diverge
  from the original game.
- **Newer `schemaVersion`**: replay is REJECTED with
  `{ ok: false, kind: "newer-schema" }`. The loader cannot interpret a
  command shape that was added after this build was compiled.
- **Older `schemaVersion`**: v1 replays are accepted via an in-memory
  shim (`outcome: undefined`), then loaded as v2. Schema v0 or below
  is REJECTED with `{ ok: false, kind: "older-schema" }`. The loader
  also accepts `unknown` at the boundary and runtime-validates shape;
  malformed input returns `{ ok: false, kind: "malformed" }`.
- **Missing card ids**: replay is REJECTED with
  `{ ok: false, kind: "missing-cards" }`. The pool may have rotated since
  the replay was recorded.
- **Corrupt command stream**: replay is REJECTED with
  `{ ok: false, kind: "malformed" }`. The loader aborts at the first
  command that fails — fast-forwarding past a bad step would silently
  desync.

## Schema version bump policy

| Change | Action |
| ------ | ------ |
| New `GameCommand.kind` added | Bump `schemaVersion` |
| Existing `GameCommand.kind` changes shape | Bump `schemaVersion` |
| Header gains a NEW required field | Bump `schemaVersion` |
| Header gains an optional field that older builds can ignore | Bump only if newer builds rely on it (v2 added optional `outcome`; bumped because the cloud aggregator filters by it) |
| Engine behavior changes but commands don't | DO NOT bump (warn via `appVersion` mismatch instead) |
| Card behavior changes | DO NOT bump (warn via `dataVersion` mismatch instead) |
| Card pool rotation | DO NOT bump; older replays surface as `missing-cards` |

The loader **must** reject newer schemas cleanly with a typed error rather
than attempting to silently degrade. Silent misinterpretation of an unknown
command kind is the worst possible failure mode.

### v1 → v2 migration

v1 (the initial Phase 5 schema) carried no `outcome`. v2 adds it as
optional. The loader accepts v1 in-memory by shimming
`outcome: undefined`, which is the correct "in-flight" semantics — v1
replays didn't track game-end. Aggregators that filter by outcome will
just see no v1 rows in the corpus, which is fine since cloud upload is
v2-only by RLS policy.

v2 also notes the historical inconsistency that v2.2 shipped 3 setup-phase
`GameCommand` kinds (`resolveCoinGuess` / `chooseFirstPlayer` /
`completeSetup`) without bumping the version. The v2 bump retroactively
covers them; v1 replays naturally don't include those kinds, but the
dispatcher still accepts them so a v1 → v2 migrated replay with setup
commands will load.

## Prompt coverage

The replay command stream covers every user-resolvable pending state on
`GameState`. The contract test in
[`src/engine/__tests__/replay.test.ts`](../src/engine/__tests__/replay.test.ts)
enumerates them and the dispatcher in `gameCommands.ts` handles each:

| Pending field | Resolved by command |
| ------------- | ------------------- |
| `pendingPick` | `resolvePendingPick` |
| `pendingSwitchTarget` | `resolveSwitchTarget` |
| `pendingInPlayTarget` | `resolveInPlayTarget` |
| `pendingHandReveal` | `resolveHandReveal` |
| `pendingSearchNotice` | (advance via continuation; not user-resolved) |
| `pendingRareCandyChoice` | `resolveRareCandyChoice` |
| `pendingPromote` | `promoteBenchToActive` |
| `pendingHeavyBaton` | (folded into `resolveInPlayTarget`) |

Engine continuations (`pendingPromoteQueue`, `pendingSecondAttack`,
`onPromoteResolved`) advance internally and intentionally do NOT appear in
the command stream — they're scheduling state, not player decisions.

## Cloud aggregation (opt-in)

v2.4 / Phase D adds an opt-in pipeline that uploads completed games to a
shared Supabase corpus. The intent: collect human play data the AI can
later be trained / tuned against. Setup recipe is in
[REPLAY_BACKEND.md](REPLAY_BACKEND.md).

How it works on the client:

1. Every completed game is saved to IndexedDB as a `StoredReplay`
   (Phase B). Local-only by default.
2. When the user opts in via Game menu → "Cloud upload", the next
   completed game's row is uploaded to Supabase. A consent modal
   precedes the first opt-in describing exactly what's sent.
3. Failures stamp `uploadError` on the local row so the
   `ReplayHistoryModal` can offer a manual retry button. The opt-in flag
   is a one-flip kill switch.

What goes up the wire:

- Decklists as **card IDs** (the schema has no deck-name field).
- The full successful command stream.
- `outcome.winner` / `completedAt` / `gameMode`.
- `appVersion` and `dataVersion` so the corpus can filter by build.
- An anonymous `client_id` (UUID generated once on the device, persisted
  to `localStorage["tcgvibes.clientId.v1"]`).

What does NOT go up the wire:

- Names, emails, IP addresses, login tokens. There's no auth.
- Custom deck labels — the recorder schema doesn't store them.
- Per-command RNG state — see "Recording" above for why.

Local-only deletion limit: a user who deletes a row from
`ReplayHistoryModal` removes it from THIS device. Uploaded copies
remain in the corpus. The consent modal must say so explicitly.
Self-serve deletion would require either real auth or a per-replay
deletion token; both are documented as Phase E follow-ups.

## Optional checkpoints (future)

The schema reserves space for periodic state checkpoints to speed up
debugging long replays. Checkpoints are JSON snapshots emitted every N
commands; on load they let the loader fast-forward without replaying every
command from the seed. Checkpoints **must not** carry per-command RNG state
(see "Recording" above).

Not implemented in v1; the schema doesn't include the field yet either.
Adding it later will not be a `schemaVersion` bump if the field is optional
and old replays without it still load.
