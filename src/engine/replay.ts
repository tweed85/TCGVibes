// GameReplay — a deterministic, self-contained record of a TCGVibes game.
//
// What's recorded:
//   - Initial RNG seed (reconstructable: replay starts the engine the same
//     way the live game did).
//   - Both players' decklist entries (resolved into Card[] by the same
//     parser the live game uses).
//   - Every successful command in order. Failed commands NEVER appear.
//   - (v2) An optional `outcome` block populated when the game ends —
//     winner, completedAt, gameMode. Lets aggregators filter by result
//     without re-running the replay.
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
//   mismatches so playback isn't silently wrong. See docs/REPLAY.md.

import { applyGameCommand, type GameCommand } from "./gameCommands";
import { setupGame } from "./rules";
import { makeRng } from "./rng";
import { APP_VERSION } from "../version";
import { datasetAsOf } from "../data/cards";
import type { Card, GameState, PlayerId } from "./types";

export const REPLAY_SCHEMA_VERSION = 2 as const;

/** Pre-v2 shape — read-only by the loader. v2.2 shipped 3 setup-phase
 *  GameCommand kinds without bumping the version, so v1 replays may carry
 *  any legal command and still load against today's dispatcher. */
export interface GameReplayV1 {
  schemaVersion: 1;
  appVersion: string;
  dataVersion: string;
  createdAt: string;
  initial: {
    p1CardIds: string[];
    p2CardIds: string[];
    rngSeed: number;
    setupOptions?: { p2IsAI?: boolean };
  };
  commands: GameCommand[];
  note?: string;
}

export interface GameReplayV2 {
  schemaVersion: 2;
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
  /** Populated when the engine reaches phase=gameOver. Absent on in-flight
   *  replays and on v1 replays loaded by a v2 build. */
  outcome?: {
    winner: PlayerId | null;
    completedAt: string;
    gameMode: "vsCPU" | "local";
  };
}

/** New replays are always v2. v1 only appears on load. */
export type GameReplay = GameReplayV2;

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
): GameReplayV2 {
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
 * Synchronously stamp `outcome` on the replay if (and only if) the game
 * just ended and `outcome` isn't already set. Pure / non-mutating: returns
 * a new replay object on success, null otherwise. Caller decides what to
 * do with the returned replay (persist, upload, etc.).
 *
 * The injected `now` clock keeps tests deterministic without monkey-
 * patching `Date`. Production callers omit it and get wall-clock time.
 *
 * Idempotent: a second call with the same input returns null because
 * `outcome` is already populated. This is the contract the App-side
 * useEffect relies on to avoid racing repeated `saveReplay` invocations.
 */
export function finalizeReplayIfDone(
  replay: GameReplayV2,
  state: GameState,
  gameMode: "vsCPU" | "local",
  now: () => string = () => new Date().toISOString(),
): GameReplayV2 | null {
  if (replay.outcome) return null;
  if (state.phase !== "gameOver") return null;
  return {
    ...replay,
    outcome: {
      winner: state.winner,
      completedAt: now(),
      gameMode,
    },
  };
}

// ---- Loader --------------------------------------------------------------

function asV1(input: unknown): GameReplayV1 | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  if (typeof r.appVersion !== "string") return null;
  if (typeof r.dataVersion !== "string") return null;
  if (typeof r.createdAt !== "string") return null;
  if (!r.initial || typeof r.initial !== "object") return null;
  const init = r.initial as Record<string, unknown>;
  if (!Array.isArray(init.p1CardIds) || !Array.isArray(init.p2CardIds)) return null;
  if (typeof init.rngSeed !== "number") return null;
  if (!Array.isArray(r.commands)) return null;
  return input as GameReplayV1;
}

function asV2(input: unknown): GameReplayV2 | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (r.schemaVersion !== 2) return null;
  if (typeof r.appVersion !== "string") return null;
  if (typeof r.dataVersion !== "string") return null;
  if (typeof r.createdAt !== "string") return null;
  if (!r.initial || typeof r.initial !== "object") return null;
  const init = r.initial as Record<string, unknown>;
  if (!Array.isArray(init.p1CardIds) || !Array.isArray(init.p2CardIds)) return null;
  if (typeof init.rngSeed !== "number") return null;
  if (!Array.isArray(r.commands)) return null;
  return input as GameReplayV2;
}

/** Migrate a v1 replay to v2 in-memory. The v1 schema is a strict subset
 *  of v2 minus `outcome`, so the migration is a thin shim — no data is
 *  recovered. Callers see `outcome: undefined` and treat the game as
 *  in-flight (which is technically correct: v1 didn't track game-end). */
function migrateV1toV2(v1: GameReplayV1): GameReplayV2 {
  return {
    schemaVersion: 2,
    appVersion: v1.appVersion,
    dataVersion: v1.dataVersion,
    createdAt: v1.createdAt,
    initial: v1.initial,
    commands: v1.commands,
    note: v1.note,
  };
}

/**
 * Load a replay and reconstruct the final state by applying every command
 * against a fresh setupGame. Resolves card ids back to Card objects via
 * the supplied lookup (callers pass `cardsById` from src/data/cards.ts).
 *
 * Accepts `unknown` at the boundary so callers can pass JSON-parsed input
 * without manually casting. Validates shape, narrows to v1 or v2, and
 * migrates v1 → v2 in-memory before running the command stream.
 */
export function loadReplay(
  input: unknown,
  cardsById: Map<string, Card>,
): ReplayLoadResult {
  // Try v2 first (newer build's preferred shape), then fall back to v1.
  const v2 = asV2(input);
  let replay: GameReplayV2 | null = v2;
  if (!replay) {
    const v1 = asV1(input);
    if (v1) {
      replay = migrateV1toV2(v1);
    }
  }
  if (!replay) {
    // Either the schemaVersion is outside [1, 2] or the shape is wrong.
    // Surface "newer-schema" for v3+, "older-schema" for v0 or below, and
    // "malformed" for anything else (missing fields, non-object, etc.).
    if (input && typeof input === "object") {
      const sv = (input as Record<string, unknown>).schemaVersion;
      if (typeof sv === "number") {
        if (sv > REPLAY_SCHEMA_VERSION) {
          return {
            ok: false,
            kind: "newer-schema",
            reason: `Replay schema v${sv} is newer than this build (v${REPLAY_SCHEMA_VERSION}). Upgrade the app to load this file.`,
          };
        }
        if (sv < 1) {
          return {
            ok: false,
            kind: "older-schema",
            reason: `Replay schema v${sv} is older than this build supports (minimum v1).`,
          };
        }
      }
    }
    return {
      ok: false,
      kind: "malformed",
      reason: "Replay file is malformed or missing required fields.",
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
