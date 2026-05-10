// GameReplay — a deterministic, self-contained record of a TCGVibes game.
//
// What's recorded:
//   - Initial RNG seed (reconstructable: replay starts the engine the same
//     way the live game did).
//   - Both players' decklist entries (resolved into Card[] by the same
//     parser the live game uses).
//   - Every successful command in order. Failed commands NEVER appear.
//
// What's NOT recorded:
//   - Per-command RNG state. The seed alone reproduces the determinism;
//     per-command state would only desync the moment the engine reorders
//     RNG calls inside an action, while the seed-driven path adapts.
//
// Determinism contract:
//   Replay reproduces the original game ONLY against the same engine code
//   path (`appVersion`) and the same card dataset (`dataVersion`). The
//   loader rejects newer schemas cleanly, and warns on app/data version
//   mismatches so playback isn't silently wrong. See
//   docs/META_SNAPSHOT_AGENT.md ↔ Phase 5 in the implementation review.

import { applyGameCommand, type GameCommand } from "./gameCommands";
import { setupGame } from "./rules";
import { makeRng } from "./rng";
import { APP_VERSION } from "../version";
import { datasetAsOf } from "../data/cards";
import type { Card, GameState } from "./types";

export const REPLAY_SCHEMA_VERSION = 1 as const;

export interface GameReplay {
  schemaVersion: typeof REPLAY_SCHEMA_VERSION;
  appVersion: string;             // src/version.ts APP_VERSION
  dataVersion: string;            // datasetAsOf at record time
  createdAt: string;              // ISO timestamp
  initial: {
    /** Card ids for player 1's resolved deck (in deck-build order). */
    p1CardIds: string[];
    p2CardIds: string[];
    /** Initial RNG seed. The engine's RNG is reconstructed from this. */
    rngSeed: number;
    /** Game-start options forwarded to setupGame. */
    setupOptions?: { p2IsAI?: boolean };
  };
  commands: GameCommand[];
  /** Optional human-readable note (a label / win condition / context). */
  note?: string;
}

export interface ReplayLoadError {
  ok: false;
  kind: "newer-schema" | "older-schema" | "missing-cards" | "malformed";
  reason: string;
}

export interface ReplayLoadOk {
  ok: true;
  state: GameState;
  appVersionMatch: boolean;
  dataVersionMatch: boolean;
  /** Plain-English warnings for any version drift the user should know about. */
  warnings: string[];
}

export type ReplayLoadResult = ReplayLoadOk | ReplayLoadError;

/**
 * Build a fresh replay header for the live game. Pass the resolved decks
 * (Card[]) used at game start and the seed used by the live RNG.
 *
 * The recorder appends commands to `replay.commands` only after the
 * engine returns `ok: true` — failed commands never appear in the stream.
 */
export function newReplay(
  p1Cards: Card[],
  p2Cards: Card[],
  rngSeed: number,
  setupOptions?: { p2IsAI?: boolean },
  note?: string,
): GameReplay {
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    dataVersion: datasetAsOf,
    createdAt: new Date().toISOString(),
    initial: {
      p1CardIds: p1Cards.map((c) => c.id),
      p2CardIds: p2Cards.map((c) => c.id),
      rngSeed,
      setupOptions,
    },
    commands: [],
    note,
  };
}

/**
 * Load a replay and reconstruct the final state by applying every command
 * against a fresh setupGame. Resolves card ids back to Card objects via
 * the supplied lookup (callers pass `cardsById` from src/data/cards.ts).
 *
 * Returns a typed result: success with warnings on app/data mismatch, or
 * a failure with a clear `kind` for the loader to render.
 */
export function loadReplay(
  replay: GameReplay,
  cardsById: Map<string, Card>,
): ReplayLoadResult {
  if (replay.schemaVersion > REPLAY_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: "newer-schema",
      reason: `Replay schema v${replay.schemaVersion} is newer than this build (v${REPLAY_SCHEMA_VERSION}). Upgrade the app to load this file.`,
    };
  }
  if (replay.schemaVersion < REPLAY_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: "older-schema",
      reason: `Replay schema v${replay.schemaVersion} is older than this build (v${REPLAY_SCHEMA_VERSION}). A future migration tool may be able to upgrade it.`,
    };
  }
  const resolveDeck = (ids: string[]): Card[] | null => {
    const out: Card[] = [];
    for (const id of ids) {
      const card = cardsById.get(id);
      if (!card) return null;
      out.push({ ...card });
    }
    return out;
  };
  const p1 = resolveDeck(replay.initial.p1CardIds);
  const p2 = resolveDeck(replay.initial.p2CardIds);
  if (!p1 || !p2) {
    return {
      ok: false,
      kind: "missing-cards",
      reason:
        "One or more cards in this replay aren't in the current dataset. The pool may have rotated since the replay was recorded.",
    };
  }
  const state = setupGame(
    p1,
    p2,
    makeRng(replay.initial.rngSeed),
    replay.initial.setupOptions,
  );
  // Apply commands in order. Failed commands signal corruption — abort
  // with a malformed result rather than fast-forwarding past the bad
  // step, which would silently desync.
  for (let i = 0; i < replay.commands.length; i++) {
    const c = replay.commands[i];
    const r = applyGameCommand(state, c);
    if (!r.ok) {
      return {
        ok: false,
        kind: "malformed",
        reason: `Command ${i} (${c.kind}) failed during replay: ${r.reason}`,
      };
    }
  }
  const warnings: string[] = [];
  if (replay.appVersion !== APP_VERSION) {
    warnings.push(
      `Replay was recorded with appVersion ${replay.appVersion}; this build is ${APP_VERSION}. Engine behavior may differ.`,
    );
  }
  if (replay.dataVersion !== datasetAsOf) {
    warnings.push(
      `Replay was recorded with dataVersion ${replay.dataVersion}; this build is ${datasetAsOf}. Card behavior may differ.`,
    );
  }
  return {
    ok: true,
    state,
    appVersionMatch: replay.appVersion === APP_VERSION,
    dataVersionMatch: replay.dataVersion === datasetAsOf,
    warnings,
  };
}
