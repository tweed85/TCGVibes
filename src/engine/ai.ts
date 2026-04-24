// Simple AI: greedy / random legal-move picker.
// Priority: attack if possible -> evolve -> attach energy -> play basic -> end turn.

import {
  attachEnergy,
  attack,
  endTurn,
  evolve,
  playBasicToBench,
  playTrainer,
  promoteBenchToActive,
} from "./actions";
import { canPayCost, chooseFirstPlayer, completeSetup, energyProvidedBy, isBasic, isPokemon } from "./rules";
import { effectiveMaxHp } from "./ongoingEffects";
import { resolveAiPendingPick } from "./pendingPick";
import type { GameState, PlayerId, PokemonCard } from "./types";

// AI's coin-flip choice: if it's the winner, pick to go second (slight meta
// advantage — second player can attack on their first turn).
export function resolveAiCoinChoice(state: GameState): boolean {
  if (state.phase !== "coinFlip" || !state.coinFlip || state.coinFlip.step !== "chooseFirst") return false;
  if (state.coinFlip.winner !== "p2") return false;
  chooseFirstPlayer(state, "p2", false); // go second
  return true;
}

// Opening setup: promote the highest-HP Basic in hand to Active and bench
// every other Basic in the hand.
export function resolveAiSetup(state: GameState, player: PlayerId): boolean {
  if (state.phase !== "setup") return false;
  const pl = state.players[player];
  if (pl.setupComplete) return false;
  const basicIdxs = pl.hand
    .map((c, i) => ({ c, i }))
    .filter((x) => isPokemon(x.c) && isBasic(x.c));
  if (basicIdxs.length === 0) return false;
  // Highest-HP as Active.
  let bestIdx = basicIdxs[0].i;
  let bestHp = (basicIdxs[0].c as PokemonCard).hp;
  for (const { c, i } of basicIdxs) {
    const hp = (c as PokemonCard).hp;
    if (hp > bestHp) { bestIdx = i; bestHp = hp; }
  }
  const benchIdxs = basicIdxs
    .map((x) => x.i)
    .filter((i) => i !== bestIdx)
    .slice(0, 5);
  completeSetup(state, player, bestIdx, benchIdxs);
  return true;
}

// Called any time the AI might need to act — both for its own turn and for
// resolving promotes during the human player's turn.
export function resolveAiPendingPromote(state: GameState, player: PlayerId): boolean {
  if (state.pendingPromote !== player) return false;
  const pl = state.players[player];
  // Pick the highest-HP benched Pokémon (a reasonable heuristic).
  if (pl.bench.length === 0) return false;
  let best = 0;
  for (let i = 1; i < pl.bench.length; i++) {
    if (effectiveMaxHp(pl.bench[i], state) > effectiveMaxHp(pl.bench[best], state)) best = i;
  }
  promoteBenchToActive(state, player, best);
  return true;
}

export function takeAiTurn(state: GameState, player: PlayerId): void {
  // Resolve any pending promote the AI owes before taking normal actions.
  if (state.pendingPromote === player) resolveAiPendingPromote(state, player);

  let safety = 40;
  while (safety-- > 0) {
    if (state.phase === "gameOver" || state.activePlayer !== player) return;
    if (state.pendingPromote === player) {
      resolveAiPendingPromote(state, player);
      continue;
    }
    if (state.pendingPick && state.pendingPick.player === player) {
      resolveAiPendingPick(state, player);
      continue;
    }
    const pl = state.players[player];

    // 1. Play basics to bench (fill slots).
    const basicIdx = pl.hand.findIndex(
      (c) => isPokemon(c) && isBasic(c),
    );
    if (basicIdx >= 0 && pl.bench.length < 5) {
      if (playBasicToBench(state, player, basicIdx).ok) continue;
    }

    // 2a. Play a Supporter if we have one and haven't yet this turn
    // (skips first-player-first-turn ban via the action's own guard).
    if (!pl.supporterPlayedThisTurn) {
      const supIdx = pl.hand.findIndex(
        (c) => c.supertype === "Trainer" && c.subtypes.includes("Supporter"),
      );
      if (supIdx >= 0 && playTrainer(state, player, supIdx).ok) continue;
    }
    // 2b. Play any Item card (always safe).
    {
      const itemIdx = pl.hand.findIndex(
        (c) => c.supertype === "Trainer" && c.subtypes.includes("Item"),
      );
      if (itemIdx >= 0 && playTrainer(state, player, itemIdx).ok) continue;
    }

    // 2. Evolve anything possible.
    let didEvolve = false;
    for (let i = 0; i < pl.hand.length; i++) {
      const c = pl.hand[i];
      if (!isPokemon(c) || !c.evolvesFrom) continue;
      const targets = [pl.active, ...pl.bench].filter(Boolean);
      const t = targets.find(
        (p) => p && p.card.name === c.evolvesFrom && !p.playedThisTurn && !p.evolvedThisTurn,
      );
      if (t && evolve(state, player, i, t.instanceId).ok) {
        didEvolve = true;
        break;
      }
    }
    if (didEvolve) continue;

    // 3. Attach energy — prefer active if it gets closer to an attack.
    if (!pl.energyAttachedThisTurn) {
      const energyIdx = pl.hand.findIndex((c) => c.supertype === "Energy");
      if (energyIdx >= 0) {
        const target = pl.active ?? pl.bench[0];
        if (target && attachEnergy(state, player, energyIdx, target.instanceId).ok) continue;
      }
    }

    // 4. Attack if we can.
    if (!state.firstTurnNoAttack && pl.active) {
      const attacks = pl.active.card.attacks;
      const provided = energyProvidedBy(pl.active);
      // Pick the highest-damage attack we can pay for.
      let best = -1;
      let bestDmg = -1;
      for (let i = 0; i < attacks.length; i++) {
        if (canPayCost(provided, attacks[i].cost) && attacks[i].damage > bestDmg) {
          best = i;
          bestDmg = attacks[i].damage;
        }
      }
      if (best >= 0) {
        attack(state, player, best);
        return;
      }
    }

    // Nothing left worth doing — end turn.
    endTurn(state, player);
    return;
  }
  // Safety break.
  endTurn(state, player);
}
