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
  schemaVersion: 1,           // bump when GameCommand shape changes
  appVersion,                 // src/version.ts → APP_VERSION
  dataVersion,                // src/data/cards.ts → datasetAsOf
  createdAt,                  // ISO timestamp
  initial: {
    p1CardIds, p2CardIds,     // resolved Card.id arrays in deck-build order
    rngSeed,                  // single seed; per-command RNG is NOT recorded
    setupOptions,
  },
  commands: [],
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
- **Older `schemaVersion`**: replay is REJECTED with
  `{ ok: false, kind: "older-schema" }`. A future migration tool may
  upgrade older replays; today they're flagged for manual conversion.
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
| Engine behavior changes but commands don't | DO NOT bump (warn via `appVersion` mismatch instead) |
| Card behavior changes | DO NOT bump (warn via `dataVersion` mismatch instead) |
| Card pool rotation | DO NOT bump; older replays surface as `missing-cards` |

The loader **must** reject newer schemas cleanly with a typed error rather
than attempting to silently degrade. Silent misinterpretation of an unknown
command kind is the worst possible failure mode.

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

## Optional checkpoints (future)

The schema reserves space for periodic state checkpoints to speed up
debugging long replays. Checkpoints are JSON snapshots emitted every N
commands; on load they let the loader fast-forward without replaying every
command from the seed. Checkpoints **must not** carry per-command RNG state
(see "Recording" above).

Not implemented in v1; the schema doesn't include the field yet either.
Adding it later will not be a `schemaVersion` bump if the field is optional
and old replays without it still load.
