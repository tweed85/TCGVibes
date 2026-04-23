// Simple AI: greedy / random legal-move picker.
// Priority: attack if possible -> evolve -> attach energy -> play basic -> end turn.

import {
  attachEnergy,
  attack,
  endTurn,
  evolve,
  playBasicToBench,
} from "./actions";
import { canPayCost, energyProvidedBy, isBasic, isPokemon } from "./rules";
import type { GameState, PlayerId } from "./types";

export function takeAiTurn(state: GameState, player: PlayerId): void {
  let safety = 30;
  while (safety-- > 0) {
    if (state.phase === "gameOver" || state.activePlayer !== player) return;
    const pl = state.players[player];

    // 1. Play basics to bench (fill slots).
    const basicIdx = pl.hand.findIndex(
      (c) => isPokemon(c) && isBasic(c),
    );
    if (basicIdx >= 0 && pl.bench.length < 5) {
      if (playBasicToBench(state, player, basicIdx).ok) continue;
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
