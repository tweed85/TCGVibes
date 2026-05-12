// Weakness + Resistance must be applied to the FINAL damage value, AFTER
// attack-effect additions like per-bench / per-energy. A prior bug applied
// W/R only to the base + attacker bonuses, so per-bench damage skipped the
// multiplier entirely. These tests lock in the correct order.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  makePokemonInPlay,
  isBasic,
  isPokemon,
} from "../rules";
import { makeRng } from "../rng";
import { attack } from "../actions";
import { allCards, findByName } from "../../data/cards";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState, PlayerId, PokemonCard, EnergyCard } from "../types";

function boot(): { state: GameState; ap: PlayerId; op: PlayerId } {
  const state = setupGame(buildDeck(DECK_SPECS[0]), buildDeck(DECK_SPECS[0]), makeRng(1), {
    p2IsAI: false,
  });
  resolveCoinGuess(state, "heads");
  chooseFirstPlayer(state, state.coinFlip!.winner!, true);
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const idx = state.players[pid].hand.findIndex((c) => isPokemon(c) && isBasic(c));
    completeSetup(state, pid, idx, []);
  }
  state.firstTurnNoAttack = false;
  state.turn = 2;
  const ap = state.activePlayer;
  const op: PlayerId = ap === "p1" ? "p2" : "p1";
  return { state, ap, op };
}

describe("Weakness / Resistance damage order", () => {
  it("doubles per-bench scaling damage when defender is weak to attacker type", () => {
    const { state, ap, op } = boot();
    // Dipplin (Grass) with 4 benched allies = +80 damage from "Do the Wave".
    const dipplin = allCards.find(
      (c) => c.name === "Dipplin" && c.setCode === "sv6" && c.number === "18",
    );
    expect(dipplin).toBeDefined();
    const attacker = makePokemonInPlay(dipplin as PokemonCard);
    attacker.attachedEnergy.push(findByName("Basic Grass Energy") as EnergyCard);
    state.players[ap].active = attacker;
    for (let i = 0; i < 4; i++) {
      state.players[ap].bench.push(makePokemonInPlay(findByName("Dipplin") as PokemonCard));
    }
    // Lunatone — Fighting, weak ×2 to Grass.
    const lunatone = allCards.find((c) => c.name === "Lunatone" && c.setCode === "me1");
    expect(lunatone).toBeDefined();
    state.players[op].active = makePokemonInPlay(lunatone as PokemonCard);
    attack(state, ap, 0);
    // 20 × 4 bench = 80 base. ×2 weakness = 160. Lunatone has 110 HP → KO.
    // We can't read "damage" post-KO, but the defender was moved to discard.
    const discarded = state.players[op].discard.some((c) => c.name === "Lunatone");
    expect(discarded).toBe(true);
    // Verify the system log shows 160 (the full post-weakness damage).
    const hit = state.log.find((e) => e.text.includes("takes 160 damage"));
    expect(hit).toBeDefined();
  });

  it("does NOT double damage when defender is not weak to attacker type", () => {
    const { state, ap, op } = boot();
    const dipplin = allCards.find(
      (c) => c.name === "Dipplin" && c.setCode === "sv6" && c.number === "18",
    );
    const attacker = makePokemonInPlay(dipplin as PokemonCard);
    attacker.attachedEnergy.push(findByName("Basic Grass Energy") as EnergyCard);
    state.players[ap].active = attacker;
    for (let i = 0; i < 4; i++) {
      state.players[ap].bench.push(makePokemonInPlay(findByName("Dipplin") as PokemonCard));
    }
    // Grookey (Grass) — not Grass-weak; no weakness change expected.
    const grookey = allCards.find((c) => c.name === "Grookey" && c.setCode === "sv6");
    expect(grookey).toBeDefined();
    state.players[op].active = makePokemonInPlay(grookey as PokemonCard);
    const before = state.players[op].active!.damage;
    attack(state, ap, 0);
    const hit = state.log.find((e) => e.text.match(/attacks with Do the Wave for (\d+)/));
    const m = hit?.text.match(/for (\d+)/);
    const dealt = m ? parseInt(m[1], 10) : 0;
    // Should be 80, not 160 — no weakness to Grass.
    expect(dealt).toBe(80);
    const after = state.players[op].active
      ? state.players[op].active!.damage
      : 80 /* KO'd — but Grookey is 70 HP so would KO */;
    void after; void before;
  });
});
