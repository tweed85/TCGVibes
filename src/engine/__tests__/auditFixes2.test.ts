// Round-2 audit fixes (5-agent card-mechanics sweep):
//   - Switch picker engine path (user-reported "no action follows")
//   - Deluxe Bomb 60 → 120 counter damage
//   - Heavy Baton max 4 → 3 + Basic-Energy-only filter
//   - Psychic Draw house rule removed (Active no longer blocked)
//   - Festival Lead activeHasAbilityNamed honors suppressors

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  isBasic,
  isPokemon,
  completeSetup,
} from "../rules";
import { playTrainer } from "../actions";
import {
  resolveSwitchTarget,
  detectTrainerEffect,
} from "../trainerEffects";
import { fireTriggeredOnEvolve } from "../abilities";
import { toolOnDamageActions, toolOnKoActions } from "../ongoingEffects";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  GameState,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "../types";

function bootGameToMain(seed = 1): GameState {
  const state = setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: false },
  );
  resolveCoinGuess(state, "heads");
  chooseFirstPlayer(state, state.coinFlip!.winner!, true);
  for (const pid of ["p1", "p2"] as const) {
    const idx = state.players[pid].hand.findIndex(
      (c) => isPokemon(c) && isBasic(c),
    );
    completeSetup(state, pid, idx, []);
  }
  state.firstTurnNoAttack = false;
  state.turn = 3;
  return state;
}

const mkBasic = (id: string, opts: Partial<PokemonCard> = {}): PokemonCard => ({
  id,
  name: id,
  supertype: "Pokémon",
  subtypes: ["Basic"],
  hp: 80,
  types: ["Colorless"],
  attacks: [],
  retreatCost: [],
  ...opts,
} as PokemonCard);

const mkInPlay = (
  card: PokemonCard,
  opts: Partial<PokemonInPlay> = {},
): PokemonInPlay => ({
  instanceId: `inst-${card.id}-${Math.random().toString(36).slice(2, 7)}`,
  card,
  damage: 0,
  attachedEnergy: [],
  evolvedFrom: [],
  tools: [],
  playedThisTurn: false,
  evolvedThisTurn: false,
  statuses: [],
  abilityUsedThisTurn: false,
  ...opts,
} as PokemonInPlay);

// ---------------------------------------------------------------------------
// Switch — engine path verified end-to-end (user-reported repro)
// ---------------------------------------------------------------------------

describe("Switch — engine path", () => {
  it("plays Switch with 2+ bench → opens picker → resolveSwitchTarget swaps", () => {
    const state = bootGameToMain(2001);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].bench = [
      mkInPlay(mkBasic("a"), { instanceId: "ba", card: { ...mkBasic("a"), name: "BenchA" } }),
      mkInPlay(mkBasic("b"), { instanceId: "bb", card: { ...mkBasic("b"), name: "BenchB" } }),
    ];

    const switchCard: TrainerCard = {
      id: "switch",
      name: "Switch",
      supertype: "Trainer",
      subtypes: ["Item"],
      text: "Switch your Active Pokémon with 1 of your Benched Pokémon.",
      rules: ["Switch your Active Pokémon with 1 of your Benched Pokémon."],
      effectId: detectTrainerEffect({
        name: "Switch",
        supertype: "Trainer",
        subtypes: ["Item"],
        rules: ["Switch your Active Pokémon with 1 of your Benched Pokémon."],
      }),
    } as TrainerCard;
    expect(switchCard.effectId).toBe("simpleSwitch");

    state.players[ap].hand = [switchCard, ...state.players[ap].hand];
    const beforeActiveName = state.players[ap].active!.card.name;

    const r = playTrainer(state, ap, 0);
    expect(r.ok).toBe(true);
    expect(state.pendingSwitchTarget).toBe(ap);

    const r2 = resolveSwitchTarget(state, ap, 1);
    expect(r2.ok).toBe(true);
    expect(state.players[ap].active!.card.name).toBe("BenchB");
    expect(state.players[ap].bench.map((p) => p.card.name)).toContain(beforeActiveName);
    expect(state.pendingSwitchTarget).toBeNull();
  });

  it("Switch with 1 bench auto-resolves immediately (no picker)", () => {
    const state = bootGameToMain(2002);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].bench = [
      mkInPlay(mkBasic("a"), { instanceId: "ba", card: { ...mkBasic("a"), name: "BenchOnly" } }),
    ];
    const switchCard: TrainerCard = {
      id: "switch2",
      name: "Switch",
      supertype: "Trainer",
      subtypes: ["Item"],
      text: "...",
      rules: ["Switch your Active Pokémon with 1 of your Benched Pokémon."],
      effectId: "simpleSwitch",
    } as TrainerCard;
    state.players[ap].hand = [switchCard, ...state.players[ap].hand];
    const beforeActiveName = state.players[ap].active!.card.name;
    const r = playTrainer(state, ap, 0);
    expect(r.ok).toBe(true);
    expect(state.pendingSwitchTarget).toBeNull();
    expect(state.players[ap].active!.card.name).toBe("BenchOnly");
    expect(state.players[ap].bench[0].card.name).toBe(beforeActiveName);
  });
});

// ---------------------------------------------------------------------------
// Deluxe Bomb counter damage
// ---------------------------------------------------------------------------

describe("Deluxe Bomb", () => {
  it("emits 120 counter damage (12 counters), not 60", () => {
    const state = bootGameToMain(2101);
    const ap = state.activePlayer;
    const defender = mkInPlay(mkBasic("def"), {
      tools: [{
        id: "deluxe-bomb-test",
        name: "Deluxe Bomb",
        supertype: "Trainer",
        subtypes: ["Pokémon Tool", "ACE SPEC"],
        text: "...",
      } as TrainerCard],
    });
    state.players[ap].active = defender;
    const acts = toolOnDamageActions(state, defender, true);
    const deluxe = acts.find((a) => a.kind === "counterDamage");
    expect(deluxe).toBeDefined();
    if (deluxe && deluxe.kind === "counterDamage") {
      expect(deluxe.damage).toBe(120);
    }
  });
});

// ---------------------------------------------------------------------------
// Heavy Baton — max 3 + Basic Energy filter
// ---------------------------------------------------------------------------

describe("Heavy Baton", () => {
  it("emits moveEnergyToBench with max 3 (not 4)", () => {
    const state = bootGameToMain(2201);
    const ap = state.activePlayer;
    const defender = mkInPlay(mkBasic("ko-test", { retreatCost: ["Colorless", "Colorless", "Colorless", "Colorless"] }), {
      tools: [{
        id: "heavy-baton-test",
        name: "Heavy Baton",
        supertype: "Trainer",
        subtypes: ["Pokémon Tool"],
        text: "...",
      } as TrainerCard],
    });
    state.players[ap].active = defender;
    const acts = toolOnKoActions(state, defender);
    const heavy = acts.find((a) => a.kind === "moveEnergyToBench");
    expect(heavy).toBeDefined();
    if (heavy && heavy.kind === "moveEnergyToBench") {
      expect(heavy.max).toBe(3);
    }
  });

  it("does NOT trigger when retreat cost ≠ 4", () => {
    const state = bootGameToMain(2202);
    const ap = state.activePlayer;
    const defender = mkInPlay(mkBasic("ko-test", { retreatCost: ["Colorless", "Colorless"] }), {
      tools: [{
        id: "heavy-baton-test-2",
        name: "Heavy Baton",
        supertype: "Trainer",
        subtypes: ["Pokémon Tool"],
        text: "...",
      } as TrainerCard],
    });
    state.players[ap].active = defender;
    const acts = toolOnKoActions(state, defender);
    expect(acts.find((a) => a.kind === "moveEnergyToBench")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Psychic Draw — house rule removed (Active no longer blocked)
// ---------------------------------------------------------------------------

describe("Psychic Draw", () => {
  it("Alakazam draws 3 even when Active", () => {
    const state = bootGameToMain(2301);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      ...state.players[ap].active!.card,
      name: "Alakazam",
      abilities: [{ name: "Psychic Draw", text: "Draw 3 cards.", type: "Ability" }],
    } as PokemonCard;
    state.players[ap].active!.evolvedThisTurn = true;
    state.players[ap].active!.abilityUsedThisTurn = false;
    state.players[ap].hand = [];
    fireTriggeredOnEvolve(state, ap, state.players[ap].active!);
    expect(state.players[ap].hand.length).toBe(3);
  });

  it("Kadabra draws 2 even when Active", () => {
    const state = bootGameToMain(2302);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      ...state.players[ap].active!.card,
      name: "Kadabra",
      abilities: [{ name: "Psychic Draw", text: "Draw 2 cards.", type: "Ability" }],
    } as PokemonCard;
    state.players[ap].active!.evolvedThisTurn = true;
    state.players[ap].active!.abilityUsedThisTurn = false;
    state.players[ap].hand = [];
    fireTriggeredOnEvolve(state, ap, state.players[ap].active!);
    expect(state.players[ap].hand.length).toBe(2);
  });
});
