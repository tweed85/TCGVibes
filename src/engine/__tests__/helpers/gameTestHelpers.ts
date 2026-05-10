// Engine test DSL — short verbs that read like card-effect sentences and
// run real engine code paths. Every helper goes through the production
// action surface (no private back-doors), so a test that uses
// `useAttackByName(state, p, "Phantom Dive")` is exercising the same
// `attack(state, p, idx)` path the UI hits, including `attackPreflight`.
//
// MUST NOT bypass legality gates. Tests want to assert on the real engine,
// not on a parallel "trusting" path.
//
// Failure messages should always include enough context (player, current
// hand, current attacks) to debug a name miss in one read — dataset
// rotation is a regular cause of "card not found" surprises.

import type { ActionResult } from "../../actions";
import {
  attachEnergy,
  attack,
  evolve,
  playBasicToBench,
  playTrainer,
  retreat,
  type TrainerTarget,
} from "../../actions";
import { activateAbility } from "../../abilities";
import { resolvePendingPick } from "../../pendingPick";
import {
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
  resolveCoinGuess,
  setupGame,
} from "../../rules";
import { makeRng } from "../../rng";
import { buildDeck, DECK_SPECS } from "../../../data/decks";
import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
  PokemonInPlay,
  TrainerCard,
} from "../../types";

// ---- Setup ----------------------------------------------------------------

export interface SetupOptions {
  seed?: number;
  p1DeckId?: string;          // matches a DECK_SPECS id
  p2DeckId?: string;
  /** When true, both first-turn restrictions and turn=1 advance to a normal
   *  main phase ready for attacks. Default true — most tests want this. */
  skipFirstTurnRestrictions?: boolean;
}

/**
 * Bootstrap a fully-set-up game and advance past the coin flip / setup
 * picker into the active player's main phase. Designed so tests don't need
 * to repeat 30 lines of boilerplate.
 *
 * Tests that need to assert ON the setup phase itself should NOT use this —
 * call setupGame() directly.
 */
export function setupTestGame(opts: SetupOptions = {}): GameState {
  const seed = opts.seed ?? 1;
  const p1Spec =
    DECK_SPECS.find((s) => s.id === opts.p1DeckId) ?? DECK_SPECS[0];
  const p2Spec =
    DECK_SPECS.find((s) => s.id === opts.p2DeckId) ?? DECK_SPECS[1];
  const state = setupGame(
    buildDeck(p1Spec),
    buildDeck(p2Spec),
    makeRng(seed),
    { p2IsAI: false },
  );
  resolveCoinGuess(state, "heads");
  const winner = state.coinFlip!.winner!;
  chooseFirstPlayer(state, winner, true);
  for (const pid of ["p1", "p2"] as const) {
    const idx = state.players[pid].hand.findIndex(
      (c) => isPokemon(c) && isBasic(c),
    );
    if (idx < 0) {
      throw new Error(
        `setupTestGame: ${pid} has no Basic Pokémon in opening hand. Hand names: [${state.players[pid].hand.map((c) => c.name).join(", ")}]`,
      );
    }
    completeSetup(state, pid, idx, []);
  }
  if (opts.skipFirstTurnRestrictions !== false) {
    state.firstTurnNoAttack = false;
    state.turn = 2;
  }
  return state;
}

// ---- Read helpers ---------------------------------------------------------

export function active(state: GameState, player: PlayerId): PokemonInPlay {
  const a = state.players[player].active;
  if (!a) {
    throw new Error(
      `active(${player}): no Active Pokémon in play. Phase: ${state.phase}.`,
    );
  }
  return a;
}

export function benchByName(
  state: GameState,
  player: PlayerId,
  name: string,
): PokemonInPlay {
  const found = state.players[player].bench.find((p) => p.card.name === name);
  if (!found) {
    const present = state.players[player].bench
      .map((p) => p.card.name)
      .join(", ");
    throw new Error(
      `benchByName(${player}, "${name}"): not on bench. Bench: [${present}]`,
    );
  }
  return found;
}

export function handIndex(
  state: GameState,
  player: PlayerId,
  name: string,
): number {
  const idx = state.players[player].hand.findIndex((c) => c.name === name);
  if (idx < 0) {
    const present = state.players[player].hand
      .map((c) => c.name)
      .join(", ");
    throw new Error(
      `handIndex(${player}, "${name}"): not in hand. Hand: [${present}]`,
    );
  }
  return idx;
}

// ---- Action verbs (all routed through the production surface) ------------

export function playBasicByName(
  state: GameState,
  player: PlayerId,
  name: string,
): ActionResult {
  const idx = handIndex(state, player, name);
  return playBasicToBench(state, player, idx);
}

export function evolveByName(
  state: GameState,
  player: PlayerId,
  evolutionName: string,
  targetName: string,
): ActionResult {
  const idx = handIndex(state, player, evolutionName);
  // Find target on board (active or bench).
  const a = state.players[player].active;
  const target =
    a && a.card.name === targetName
      ? a
      : state.players[player].bench.find((p) => p.card.name === targetName);
  if (!target) {
    throw new Error(
      `evolveByName: target "${targetName}" not in play for ${player}.`,
    );
  }
  return evolve(state, player, idx, target.instanceId);
}

export function attachEnergyByName(
  state: GameState,
  player: PlayerId,
  energyName: string,
  targetName: string,
): ActionResult {
  // Match either "Basic Grass Energy" or just "Grass Energy" — the parser
  // already does this normalization at deck-import time; the DSL mirrors it
  // so test fixtures stay short.
  const hand = state.players[player].hand;
  let idx = hand.findIndex((c) => c.name === energyName);
  if (idx < 0) idx = hand.findIndex((c) => c.name === `Basic ${energyName}`);
  if (idx < 0) idx = hand.findIndex((c) => c.name.replace(/^Basic /, "") === energyName);
  if (idx < 0) {
    throw new Error(
      `attachEnergyByName(${player}, "${energyName}"): not in hand. Hand: [${hand.map((c) => c.name).join(", ")}]`,
    );
  }
  const a = state.players[player].active;
  const target =
    a && a.card.name === targetName
      ? a
      : state.players[player].bench.find((p) => p.card.name === targetName);
  if (!target) {
    throw new Error(
      `attachEnergyByName: target "${targetName}" not in play for ${player}.`,
    );
  }
  return attachEnergy(state, player, idx, target.instanceId);
}

export function playTrainerByName(
  state: GameState,
  player: PlayerId,
  name: string,
  target?: TrainerTarget,
): ActionResult {
  const idx = handIndex(state, player, name);
  return playTrainer(state, player, idx, target);
}

export function useAttackByName(
  state: GameState,
  player: PlayerId,
  attackName: string,
): ActionResult {
  const a = state.players[player].active;
  if (!a) {
    throw new Error(
      `useAttackByName(${player}, "${attackName}"): no Active.`,
    );
  }
  const idx = a.card.attacks.findIndex((atk) => atk.name === attackName);
  if (idx < 0) {
    const present = a.card.attacks.map((atk) => atk.name).join(", ");
    throw new Error(
      `useAttackByName(${player}, "${attackName}"): Active "${a.card.name}" has no such attack. Attacks: [${present}]`,
    );
  }
  return attack(state, player, idx);
}

export function useAbilityByName(
  state: GameState,
  player: PlayerId,
  holderName: string,
  abilityName: string,
): ActionResult {
  const a = state.players[player].active;
  const holder =
    a && a.card.name === holderName
      ? a
      : state.players[player].bench.find((p) => p.card.name === holderName);
  if (!holder) {
    throw new Error(
      `useAbilityByName: "${holderName}" not in play for ${player}.`,
    );
  }
  const abIdx = (holder.card.abilities ?? []).findIndex(
    (ab) => ab.name === abilityName,
  );
  if (abIdx < 0) {
    const present = (holder.card.abilities ?? []).map((a2) => a2.name).join(", ");
    throw new Error(
      `useAbilityByName: "${holderName}" has no ability "${abilityName}". Abilities: [${present}]`,
    );
  }
  const r = activateAbility(state, player, holder.instanceId, abIdx);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "ability failed" };
}

export function retreatTo(
  state: GameState,
  player: PlayerId,
  benchTargetName: string,
): ActionResult {
  const benchIdx = state.players[player].bench.findIndex(
    (p) => p.card.name === benchTargetName,
  );
  if (benchIdx < 0) {
    throw new Error(
      `retreatTo: "${benchTargetName}" not on ${player}'s bench.`,
    );
  }
  return retreat(state, player, benchIdx);
}

// ---- Pending-pick resolution ---------------------------------------------

/**
 * Resolve the current pendingPick by selecting cards whose names match
 * `picks` (in order). Useful for deck-search-style picks where tests want
 * to specify "I pick Pidgey and Pidgey" rather than computing pool indices.
 */
export function resolvePickByName(
  state: GameState,
  player: PlayerId,
  picks: string[],
): ActionResult {
  const pp = state.pendingPick;
  if (!pp) {
    throw new Error("resolvePickByName: no pendingPick on state.");
  }
  if (pp.player !== player) {
    throw new Error(
      `resolvePickByName: pendingPick belongs to ${pp.player}, not ${player}.`,
    );
  }
  const indices: number[] = [];
  const remaining = pp.pool.map((c, i) => ({ c, i, taken: false }));
  for (const name of picks) {
    const slot = remaining.find(
      (r) => !r.taken && (r.c.name === name || r.c.name === `Basic ${name}`),
    );
    if (!slot) {
      const present = pp.pool.map((c) => c.name).join(", ");
      throw new Error(
        `resolvePickByName: "${name}" not in pendingPick pool. Pool: [${present}]`,
      );
    }
    slot.taken = true;
    indices.push(slot.i);
  }
  const r = resolvePendingPick(state, player, indices);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "pick failed" };
}

// ---- Assertions -----------------------------------------------------------

/**
 * Asserts the named Pokémon (active or bench) has exactly `damage`. Throws
 * a descriptive error so a failing test reads in one line.
 */
export function expectDamage(
  state: GameState,
  player: PlayerId,
  pokemonName: string,
  damage: number,
): void {
  const all: PokemonInPlay[] = [
    ...(state.players[player].active ? [state.players[player].active!] : []),
    ...state.players[player].bench,
  ];
  const target = all.find((p) => p.card.name === pokemonName);
  if (!target) {
    throw new Error(
      `expectDamage: "${pokemonName}" not in play for ${player}.`,
    );
  }
  if (target.damage !== damage) {
    throw new Error(
      `expectDamage(${player}, "${pokemonName}"): expected ${damage}, got ${target.damage}.`,
    );
  }
}

// ---- Re-export Card type guards used by tests ----------------------------

export function isEnergy(c: Card): c is EnergyCard {
  return c.supertype === "Energy";
}
export function isTrainer(c: Card): c is TrainerCard {
  return c.supertype === "Trainer";
}
