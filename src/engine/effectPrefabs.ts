// Effect prefabs — semantic-named wrappers around the existing pendingPick
// helpers. Most card effects fall into a small set of patterns (search
// deck → bench, search deck → hand, recover from discard → hand, etc.);
// this module gives those patterns intent-revealing names that callers
// like trainerEffects.ts / abilities.ts can use directly.
//
// Engine-only — no React, no DOM. Reuses `setDeckSearchPick` /
// `setDiscardRecoveryPick` so log strings, RNG behavior, and pending-pick
// shape are byte-identical to what trainerEffects.ts emits today.
//
// Phase 3 first-migration targets:
//   - Buddy-Buddy Poffin → searchDeckToBench
//   - Energy Search      → searchDeckToHand
//   - Lana's Aid         → recoverFromDiscardToHand

import {
  setDeckSearchPick,
  setDiscardRecoveryPick,
} from "./pendingPick";
import type { Card, GameState, PlayerId } from "./types";

export interface SearchDeckOptions {
  /** Defaults to 0 (i.e. "may pick up to N"). */
  min?: number;
  /** Optional next-stage chain (Dawn-style multi-step searches). */
  postResolveChain?: import("./types").DeckSearchChainStep;
}

/**
 * Search the player's deck for cards matching `pred`, place up to `max`
 * onto the Bench (typically Basic Pokémon). Opens a pending-pick the UI
 * resolves; AI auto-picks. Returns false if no eligible card exists (the
 * deck still gets shuffled and the engine logs a "finds nothing" line).
 */
export function searchDeckToBench(
  state: GameState,
  player: PlayerId,
  pred: (c: Card) => boolean,
  max: number,
  label: string,
  options: SearchDeckOptions = {},
): boolean {
  return setDeckSearchPick(state, player, pred, max, label, {
    ...options,
    toBench: true,
  });
}

/**
 * Search the player's deck for cards matching `pred`, put up to `max` into
 * hand. Opens a pending-pick. Returns false if no eligible card exists.
 *
 * Used by simple search items (Energy Search, Pokégear 3.0) and as a
 * building block for chained searches (the postResolveChain option).
 */
export function searchDeckToHand(
  state: GameState,
  player: PlayerId,
  pred: (c: Card) => boolean,
  max: number,
  label: string,
  options: SearchDeckOptions = {},
): boolean {
  return setDeckSearchPick(state, player, pred, max, label, options);
}

/**
 * Recover up to `max` cards matching `pred` from the player's discard
 * pile into hand. Opens a pending-pick the UI resolves; AI auto-picks.
 * Returns false if discard has no eligible cards.
 */
export function recoverFromDiscardToHand(
  state: GameState,
  player: PlayerId,
  pred: (c: Card) => boolean,
  max: number,
  label: string,
): boolean {
  return setDiscardRecoveryPick(state, player, pred, max, label);
}
