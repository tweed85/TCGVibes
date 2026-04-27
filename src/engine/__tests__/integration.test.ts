// Integration tests — exercise the full attack / trainer pipeline to make
// sure wired effects actually fire end-to-end rather than just detect.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
  addStatus,
} from "../rules";
import { attack } from "../actions";
import { effectiveMaxHp } from "../ongoingEffects";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type { GameState, PokemonCard, TrainerCard } from "../types";

function bootGameToMain(seed = 1): GameState {
  const state = setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
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
    completeSetup(state, pid, idx, []);
  }
  // Clear the first-turn attack lock so integration tests can call attack() directly.
  state.firstTurnNoAttack = false;
  // Bump turn so evolutions would be legal if tested.
  state.turn = 2;
  return state;
}

function mkStadium(name: string): TrainerCard {
  return {
    id: `stadium-${name}`,
    name,
    supertype: "Trainer",
    subtypes: ["Stadium"],
    text: "",
  } as TrainerCard;
}

describe("Budew Itchy Pollen — free attack blocks opp items next turn", () => {
  it("sets itemsBlockedNextTurn on opponent when triggered", () => {
    const state = bootGameToMain(42);
    // Replace the active player's Active with a mocked Budew-like card.
    const ap = state.activePlayer;
    const budew: PokemonCard = {
      id: "budew-test",
      name: "Budew",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 30,
      types: ["Grass"],
      attacks: [
        {
          name: "Itchy Pollen",
          cost: [],
          damage: 10,
          effects: [{ kind: "blockOppItemsNextTurn" }],
        },
      ],
      retreatCost: ["Colorless"],
    };
    state.players[ap].active!.card = budew;
    attack(state, ap, 0);
    const oppId = ap === "p1" ? "p2" : "p1";
    expect(state.players[oppId].itemsBlockedNextTurn).toBe(true);
  });
});

describe("per-friendly-bench damage scaling — Dipplin-style attacks", () => {
  it("damage scales with bench size", () => {
    const state = bootGameToMain(7);
    const ap = state.activePlayer;
    // Fabricate an attacker with a "20× per friendly benched Pokémon" attack.
    state.players[ap].active!.card = {
      id: "dipplin-test",
      name: "Dipplin",
      supertype: "Pokémon",
      subtypes: ["Stage 1"],
      hp: 130,
      types: ["Grass"],
      attacks: [
        {
          name: "Do the Wave",
          cost: ["Grass"],
          damage: 0,
          damageText: "20×",
          effects: [{ kind: "perFriendlyBench", perCount: 20 }],
        },
      ],
      retreatCost: ["Colorless"],
    };
    // Give it the energy it needs.
    state.players[ap].active!.attachedEnergy = [
      {
        id: "e-grass",
        name: "Basic Grass Energy",
        supertype: "Energy",
        subtypes: ["Basic"],
        provides: ["Grass"],
      } as any,
    ];
    // Reset attacker's bench and put exactly 4 fabricated Pokémon on it —
    // expected damage = 20 * 4 = 80.
    state.players[ap].bench = [];
    for (let i = 0; i < 4; i++) {
      state.players[ap].bench.push({
        instanceId: `b${i}`,
        card: state.players[ap].active!.card,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: false,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      });
    }
    const oppId = ap === "p1" ? "p2" : "p1";
    // Give the opponent a tanky enough Active so the 80 damage doesn't KO
    // (which would set opp.active to null while pendingPromote resolves) —
    // we want the damage counters visible on a still-standing defender.
    const tankyHp = 200;
    state.players[oppId].active!.card = {
      ...state.players[oppId].active!.card,
      hp: tankyHp,
    };
    const defBefore = state.players[oppId].active!.damage;
    attack(state, ap, 0);
    const defAfter = state.players[oppId].active!.damage;
    expect(defAfter - defBefore).toBeGreaterThanOrEqual(80);
  });
});

describe("Festival Grounds + Energy attached → status immunity", () => {
  it("attempts to apply a status are blocked when stadium + energy present", () => {
    const state = bootGameToMain(12);
    state.stadium = { card: mkStadium("Festival Grounds"), controller: "p1" };
    const ap = state.activePlayer;
    const pkm = state.players[ap].active!;
    // Attach an Energy card so immunity kicks in.
    pkm.attachedEnergy = [
      {
        id: "e-grass",
        name: "Basic Grass Energy",
        supertype: "Energy",
        subtypes: ["Basic"],
        provides: ["Grass"],
      } as any,
    ];
    addStatus(state, pkm, "poisoned");
    expect(pkm.statuses).not.toContain("poisoned");
  });
});

describe("Jamming Tower suppresses Tool HP bonus", () => {
  it("HP is base when Jamming Tower is in play, even with a buffing Tool", () => {
    const state = bootGameToMain(4);
    const ap = state.activePlayer;
    const pkm = state.players[ap].active!;
    pkm.tools = [{
      id: "tool-hc",
      name: "Hero's Cape",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool"],
      text: "",
    } as TrainerCard];
    state.stadium = { card: mkStadium("Jamming Tower"), controller: "p2" };
    expect(effectiveMaxHp(pkm, state)).toBe(pkm.card.hp);
  });
});

describe("Per-Pokemon lock flags (selfCantAttack / cantRetreat)", () => {
  it("sets cantAttackUntilTurn on the attacker after a self-lock attack", () => {
    const state = bootGameToMain(99);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      id: "big-hit",
      name: "Test Big Hit",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 200,
      types: ["Colorless"],
      attacks: [
        {
          name: "Lights Out",
          cost: [],
          damage: 200,
          effects: [{ kind: "selfCantAttackNextTurn" }],
        },
      ],
      retreatCost: ["Colorless"],
    };
    const startTurn = state.turn;
    // Give the opponent a second Pokémon on bench so the 200-damage swing
    // doesn't immediately end the game (game-over short-circuits the
    // post-damage hook that sets cantAttackUntilTurn).
    const oppId = ap === "p1" ? "p2" : "p1";
    state.players[oppId].bench.push({
      instanceId: "opp-bench-lock",
      card: state.players[oppId].active!.card,
      damage: 0,
      attachedEnergy: [],
      evolvedFrom: [],
      tools: [],
      playedThisTurn: false,
      evolvedThisTurn: false,
      statuses: [],
      abilityUsedThisTurn: false,
    });
    attack(state, ap, 0);
    const atkAfter =
      state.players[ap].active ??
      state.players[ap].bench.find((p) => p.card.name === "Test Big Hit");
    if (atkAfter) {
      expect(atkAfter.cantAttackUntilTurn).toBe(startTurn + 2);
    }
  });
});

describe("Unfair Stamp — gated on KO last turn", () => {
  it("rejects play when no Pokémon was KO'd during opp's last turn", async () => {
    const { precheckTrainerEffect } = await import("../trainerEffects");
    const state = bootGameToMain(101);
    const ap = state.activePlayer;
    state.players[ap].yourPokemonKoedLastOppTurn = false;
    const stamp: TrainerCard = {
      id: "test-stamp-1",
      name: "Unfair Stamp",
      supertype: "Trainer",
      subtypes: ["Item", "ACE SPEC"],
      text: "",
      effectId: "unfairStampShuffleDraw",
    };
    const reason = precheckTrainerEffect(state, ap, stamp);
    expect(reason).not.toBeNull();
    expect(reason!.toLowerCase()).toContain("knocked out");
  });

  it("resolves when the gate is satisfied: shuffle both, you draw 5, opp draws 2", async () => {
    const { applyTrainerEffect } = await import("../trainerEffects");
    const state = bootGameToMain(102);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    state.players[ap].yourPokemonKoedLastOppTurn = true;
    const myHandBefore = state.players[ap].hand.length;
    const oppHandBefore = state.players[opp].hand.length;
    const stamp: TrainerCard = {
      id: "test-stamp-2",
      name: "Unfair Stamp",
      supertype: "Trainer",
      subtypes: ["Item", "ACE SPEC"],
      text: "",
      effectId: "unfairStampShuffleDraw",
    };
    applyTrainerEffect(state, ap, stamp);
    // We should now have exactly 5 cards (shuffle erases the prior hand,
    // then drew 5).
    expect(state.players[ap].hand.length).toBe(5);
    expect(state.players[opp].hand.length).toBe(2);
    void myHandBefore; void oppHandBefore;
  });
});

describe("Wild Growth (Meganium) doubles Grass Energy for cost checks", () => {
  it("Arboliva ex with 2 Grass attached + Wild Growth ally can pay Aroma Shot's 3 Colorless", () => {
    const state = bootGameToMain(103);
    const ap = state.activePlayer;
    // Build a Meganium-like ally on the bench with Wild Growth.
    const meganium: PokemonCard = {
      id: "meganium-test",
      name: "Meganium",
      supertype: "Pokémon",
      subtypes: ["Stage 2"],
      hp: 150,
      types: ["Grass"],
      attacks: [],
      retreatCost: ["Colorless", "Colorless"],
      abilities: [
        {
          name: "Wild Growth",
          type: "Ability",
          text: "Each Basic Grass Energy attached to all of your Pokémon provides Grass Grass Energy.",
        },
      ],
    };
    state.players[ap].bench.push({
      instanceId: "meg-1", card: meganium, damage: 0, attachedEnergy: [],
      evolvedFrom: [], tools: [], playedThisTurn: false, evolvedThisTurn: false,
      statuses: [], abilityUsedThisTurn: false,
    });
    // Make the active an Arboliva-ex-like Pokémon with the Aroma Shot cost.
    const arbo: PokemonCard = {
      id: "arboliva-test",
      name: "Arboliva ex",
      supertype: "Pokémon",
      subtypes: ["Stage 2", "ex"],
      hp: 280,
      types: ["Grass"],
      attacks: [
        { name: "Aroma Shot", cost: ["Colorless", "Colorless", "Colorless"], damage: 160 },
      ],
      retreatCost: ["Colorless", "Colorless"],
    };
    state.players[ap].active!.card = arbo;
    state.players[ap].active!.attachedEnergy = [
      { id: "g1", name: "Basic Grass Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Grass"] },
      { id: "g2", name: "Basic Grass Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Grass"] },
    ];
    const result = attack(state, ap, 0);
    expect(result.ok).toBe(true);
  });
});

describe("Phantom Dive — 200 to active, 60 spread on bench", () => {
  it("AI delivers full base damage to the defender and 6 counters on bench", () => {
    const state = bootGameToMain(33);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    // Mark attacker's player as AI so the auto-distribute path runs.
    state.players[ap].isAI = true;
    // Build a Phantom-Dive-style attacker with the wired effect.
    state.players[ap].active!.card = {
      id: "dragapult-test",
      name: "Dragapult ex",
      supertype: "Pokémon",
      subtypes: ["Stage 2", "ex"],
      hp: 320,
      types: ["Dragon"],
      attacks: [
        {
          name: "Phantom Dive",
          cost: ["Fire", "Psychic"],
          damage: 200,
          effects: [{ kind: "distributeDamage", times: 6, perHit: 10, ignoreWR: true, benchOnly: true }],
        },
      ],
      retreatCost: ["Colorless", "Colorless"],
    };
    state.players[ap].active!.attachedEnergy = [
      { id: "e-fire", name: "Basic Fire Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Fire"] },
      { id: "e-psy", name: "Basic Psychic Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Psychic"] },
    ];
    // Give opp a known Active and three Bench targets so we can verify the
    // distribution.
    const dummyHp200: PokemonCard = {
      id: "opp-active-test",
      name: "Opp Active",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 300,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    };
    state.players[opp].active!.card = dummyHp200;
    state.players[opp].active!.damage = 0;
    const benchTemplate: PokemonCard = {
      id: "opp-bench-test",
      name: "Opp Bench",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 80,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    };
    state.players[opp].bench = [
      {
        instanceId: "ob1", card: benchTemplate, damage: 0,
        attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false,
        evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
      },
      {
        instanceId: "ob2", card: benchTemplate, damage: 0,
        attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false,
        evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
      },
      {
        instanceId: "ob3", card: benchTemplate, damage: 0,
        attachedEnergy: [], evolvedFrom: [], tools: [], playedThisTurn: false,
        evolvedThisTurn: false, statuses: [], abilityUsedThisTurn: false,
      },
    ];
    attack(state, ap, 0);
    // Active takes the full 200 base.
    expect(state.players[opp].active?.damage ?? 0).toBe(200);
    // Bench cumulative damage is 60 (6 counters × 10).
    const benchDamage = state.players[opp].bench.reduce((s, p) => s + p.damage, 0);
    expect(benchDamage).toBe(60);
  });
});

describe("Run Away Draw + Poké Pad chain", () => {
  it("after Dudunsparce shuffles itself into deck and the player promotes, Poké Pad still searches the deck", async () => {
    const { activateAbility } = await import("../abilities");
    const { promoteBenchToActive, playTrainer } = await import("../actions");
    const state = bootGameToMain(11);
    const ap = state.activePlayer;
    const pl = state.players[ap];
    // Build a Dudunsparce with Run Away Draw ability and place it as Active.
    const dudunsparce: PokemonCard = {
      id: "dudunsparce-test",
      name: "Dudunsparce",
      supertype: "Pokémon",
      subtypes: ["Stage 1"],
      hp: 130,
      types: ["Colorless"],
      attacks: [],
      retreatCost: ["Colorless"],
      abilities: [
        {
          name: "Run Away Draw",
          type: "Ability",
          text: "Once during your turn, you may draw 3 cards. Then, shuffle this Pokémon and all attached cards into your deck.",
          effect: { kind: "shuffleSelfIntoDeck", oncePerTurn: true },
        },
      ],
    };
    pl.active!.card = dudunsparce;
    pl.active!.evolvedFrom = [];
    pl.active!.tools = [];
    pl.active!.attachedEnergy = [];
    pl.active!.abilityUsedThisTurn = false;
    // Make sure there's a benched Pokémon to promote into.
    if (pl.bench.length === 0) {
      pl.bench.push({
        instanceId: "bench-fill",
        card: pl.active!.card,
        damage: 0,
        attachedEnergy: [],
        evolvedFrom: [],
        tools: [],
        playedThisTurn: false,
        evolvedThisTurn: false,
        statuses: [],
        abilityUsedThisTurn: false,
      });
    }
    // Plant a Poké Pad in hand.
    const pokePad: TrainerCard = {
      id: "poke-pad-test",
      name: "Poké Pad",
      supertype: "Trainer",
      subtypes: ["Item"],
      text: "Search your deck for a Pokémon that doesn't have a Rule Box, reveal it, and put it into your hand. Then, shuffle your deck.",
      effectId: "searchNonRuleBoxPokemon",
    };
    pl.hand.push(pokePad);
    const pokePadIdx = pl.hand.length - 1;
    // Activate Run Away Draw on the Active.
    const r = activateAbility(state, ap, pl.active!.instanceId, 0);
    expect(r.ok).toBe(true);
    expect(state.pendingPromote).toBe(ap);
    // Phase stays "main" because Run Away Draw is non-terminal — the player
    // can keep playing Items / attaching Energy / etc. before choosing the
    // new Active.
    expect(state.phase).toBe("main");
    // Play Poké Pad WITHOUT promoting first — should succeed.
    const padIdx = pl.hand.findIndex((c) => c.name === "Poké Pad");
    expect(padIdx).toBeGreaterThanOrEqual(0);
    const r2 = playTrainer(state, ap, padIdx);
    expect(r2.ok).toBe(true);
    // Search modal should be open.
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toContain("Poké Pad");
    // Skip the search to clear the pendingPick.
    const { resolvePendingPick } = await import("../pendingPick");
    resolvePendingPick(state, ap, []);
    // pendingPromote is still set — the player must still pick an Active.
    expect(state.pendingPromote).toBe(ap);
    // Promote a benched Pokémon now.
    promoteBenchToActive(state, ap, 0);
    expect(state.pendingPromote).toBeNull();
    expect(state.phase).toBe("main");
    expect(pl.active).not.toBeNull();
    // Suppress unused variable warning for pokePadIdx.
    void pokePadIdx;
  });
});

describe("Import decklist → valid 60-card deck", () => {
  it("a minimal synthetic decklist builds correctly", () => {
    // Use the built-in decks module directly; there's no public import flow
    // without the UI. This is just a sanity check that preset decks + mapper
    // produce clean cards.
    const deck = buildDeck(DECK_SPECS[0]);
    expect(deck).toHaveLength(60);
    const names = new Set<string>();
    for (const c of deck) names.add(c.name);
    // At least 3 distinct card names (core + staples + energy).
    expect(names.size).toBeGreaterThanOrEqual(3);
  });
});
