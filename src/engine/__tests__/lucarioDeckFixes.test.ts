// Mega Lucario deck card-mechanics audit fixes (4-agent sweep):
//   1. Heave-Ho Catcher (Hariyama) — humans with >1 bench target now get a
//      picker; AI / single-target paths still resolve inline.
//   2. Defiant Horn (Hop's Dubwool) — same picker fix as Heave-Ho Catcher.
//   3. Nullifying Zero (Mega Zygarde ex) — Weakness/Resistance now applied
//      to the Active target; bench targets stay flat per card text.
//   4. Lunar Cycle (Lunatone) — cross-copy lock so 2 Lunatones in play
//      can't both fire the ability in the same turn.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  makePokemonInPlay,
  resolveCoinGuess,
  chooseFirstPlayer,
  isBasic,
  isPokemon,
  completeSetup,
} from "../rules";
import { fireTriggeredOnEvolve, activateAbility, annotateAbilities } from "../abilities";
import { resolveAttackEffects } from "../effects";
import { resolveInPlayTarget } from "../trainerEffects";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  GameState,
  PokemonCard,
  EnergyCard,
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

// ---------------------------------------------------------------------------
// 1. Heave-Ho Catcher — picker for humans with >1 bench target
// ---------------------------------------------------------------------------

describe("Heave-Ho Catcher (Hariyama)", () => {
  function buildHariyama(): PokemonCard {
    return {
      id: "hariyama-meg-73",
      name: "Hariyama",
      supertype: "Pokémon",
      subtypes: ["Stage 1"],
      hp: 150,
      types: ["Fighting"],
      attacks: [],
      retreatCost: ["Colorless", "Colorless", "Colorless"],
      abilities: [
        {
          name: "Heave-Ho Catcher",
          type: "Ability",
          text: "Once during your turn, when you play this Pokémon from your hand to evolve 1 of your Pokémon, you may use this Ability. Switch in 1 of your opponent's Benched Pokémon to the Active Spot.",
        },
      ],
    } as PokemonCard;
  }

  it("opens a picker for a human player with >1 bench target", () => {
    const state = bootGameToMain(3001);
    state.players.p1.isAI = false;
    // Opp setup: active + 2 bench
    state.players.p2.active = makePokemonInPlay(mkBasic("active", { name: "OppActive", hp: 100 }));
    state.players.p2.bench = [
      makePokemonInPlay(mkBasic("b1", { name: "BenchA", hp: 60 })),
      makePokemonInPlay(mkBasic("b2", { name: "BenchB", hp: 90 })),
    ];

    const evolved = makePokemonInPlay(buildHariyama());
    evolved.evolvedThisTurn = true;
    state.players.p1.bench.push(evolved);

    fireTriggeredOnEvolve(state, "p1", evolved);

    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget?.action.kind).toBe("pokemonCatcher");
    expect(state.pendingInPlayTarget?.scope).toBe("opp");
    expect(state.pendingInPlayTarget?.slot).toBe("bench");
    // Opp's active is unchanged at this point — no auto-gust happened.
    expect(state.players.p2.active!.card.name).toBe("OppActive");
  });

  it("resolveInPlayTarget completes the gust on the picked target", () => {
    const state = bootGameToMain(3002);
    state.players.p1.isAI = false;
    state.players.p2.active = makePokemonInPlay(mkBasic("active", { name: "OppActive", hp: 100 }));
    state.players.p2.bench = [
      makePokemonInPlay(mkBasic("b1", { name: "BenchA", hp: 60 })),
      makePokemonInPlay(mkBasic("b2", { name: "BenchB", hp: 90 })),
    ];
    const targetId = state.players.p2.bench[0].instanceId;

    const evolved = makePokemonInPlay(buildHariyama());
    evolved.evolvedThisTurn = true;
    state.players.p1.bench.push(evolved);
    fireTriggeredOnEvolve(state, "p1", evolved);

    const r = resolveInPlayTarget(state, "p1", "p2", targetId);
    expect(r.ok).toBe(true);
    expect(state.players.p2.active!.card.name).toBe("BenchA");
    expect(state.pendingInPlayTarget).toBeNull();
  });

  it("AI player auto-resolves inline (no picker)", () => {
    const state = bootGameToMain(3003);
    state.players.p1.isAI = true;
    state.players.p2.active = makePokemonInPlay(mkBasic("active", { name: "OppActive", hp: 100 }));
    state.players.p2.bench = [
      makePokemonInPlay(mkBasic("b1", { name: "Weak", hp: 60 })),
      makePokemonInPlay(mkBasic("b2", { name: "Strong", hp: 200 })),
    ];

    const evolved = makePokemonInPlay(buildHariyama());
    evolved.evolvedThisTurn = true;
    state.players.p1.bench.push(evolved);
    fireTriggeredOnEvolve(state, "p1", evolved);

    expect(state.pendingInPlayTarget).toBeNull();
    // AI heuristic = highest HP target.
    expect(state.players.p2.active!.card.name).toBe("Strong");
  });

  it("Single-bench-target auto-resolves even for human (skip vacuous picker)", () => {
    const state = bootGameToMain(3004);
    state.players.p1.isAI = false;
    state.players.p2.active = makePokemonInPlay(mkBasic("active", { name: "OppActive", hp: 100 }));
    state.players.p2.bench = [makePokemonInPlay(mkBasic("b1", { name: "OnlyOne", hp: 60 }))];

    const evolved = makePokemonInPlay(buildHariyama());
    evolved.evolvedThisTurn = true;
    state.players.p1.bench.push(evolved);
    fireTriggeredOnEvolve(state, "p1", evolved);

    expect(state.pendingInPlayTarget).toBeNull();
    expect(state.players.p2.active!.card.name).toBe("OnlyOne");
  });
});

// ---------------------------------------------------------------------------
// 2. Defiant Horn (Hop's Dubwool) — same picker fix
// ---------------------------------------------------------------------------

describe("Defiant Horn (Hop's Dubwool)", () => {
  function buildDubwool(): PokemonCard {
    return {
      id: "hops-dubwool",
      name: "Hop's Dubwool",
      supertype: "Pokémon",
      subtypes: ["Stage 1"],
      hp: 100,
      types: ["Colorless"],
      attacks: [],
      retreatCost: ["Colorless"],
      abilities: [
        {
          name: "Defiant Horn",
          type: "Ability",
          text: "When you play this Pokémon from your hand to evolve 1 of your Pokémon, switch in 1 of your opponent's Benched Pokémon to the Active Spot.",
        },
      ],
    } as PokemonCard;
  }

  it("opens a picker for human with >1 bench target", () => {
    const state = bootGameToMain(3101);
    state.players.p1.isAI = false;
    state.players.p2.active = makePokemonInPlay(mkBasic("a", { name: "OppA", hp: 100 }));
    state.players.p2.bench = [
      makePokemonInPlay(mkBasic("b1", { name: "B1", hp: 50 })),
      makePokemonInPlay(mkBasic("b2", { name: "B2", hp: 110 })),
    ];

    const evolved = makePokemonInPlay(buildDubwool());
    evolved.evolvedThisTurn = true;
    state.players.p1.bench.push(evolved);
    fireTriggeredOnEvolve(state, "p1", evolved);

    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget?.action.kind).toBe("pokemonCatcher");
    expect(state.players.p2.active!.card.name).toBe("OppA");
  });
});

// ---------------------------------------------------------------------------
// 3. Nullifying Zero — Weakness/Resistance applies to Active only
// ---------------------------------------------------------------------------

describe("Nullifying Zero (Mega Zygarde ex)", () => {
  it("applies Weakness to Active target; bench remains flat", () => {
    const state = bootGameToMain(3201);
    // Force all coin flips to heads — guarantees every target is hit.
    state.rng = { next: () => 0.0, getState: () => 0, setState: () => {}, int: () => 0 } as GameState["rng"];

    const attacker = makePokemonInPlay(mkBasic("zyg", { name: "Mega Zygarde ex", types: ["Fighting"] }));
    state.players.p1.active = attacker;

    // Active is Fighting-weak (×2). Bench is Fighting-weak too — but card
    // text says "Don't apply Weakness and Resistance for Benched Pokémon".
    const weakActive = makePokemonInPlay({
      ...mkBasic("def", { name: "WeakActive", hp: 200 }),
      weaknesses: [{ type: "Fighting", value: "×2" }],
    } as PokemonCard);
    const weakBench = makePokemonInPlay({
      ...mkBasic("benchDef", { name: "BenchDef", hp: 200 }),
      weaknesses: [{ type: "Fighting", value: "×2" }],
    } as PokemonCard);
    state.players.p2.active = weakActive;
    state.players.p2.bench = [weakBench];

    const move = {
      name: "Nullifying Zero",
      cost: [],
      damage: 0,
      effects: [{ kind: "multiCoinPerOppPokemon" as const, damagePerHeads: 150 }],
    };
    const res = resolveAttackEffects(state, {
      attacker,
      attackerOwner: "p1",
      defender: weakActive,
      defenderOwner: "p2",
      move,
      damage: 0,
    });
    res.postDamage?.();

    // Active: 150 base × 2 weakness = 300.
    expect(weakActive.damage).toBe(300);
    // Bench: 150 flat (weakness intentionally NOT applied).
    expect(weakBench.damage).toBe(150);
  });

  it("applies Resistance to Active target; bench remains flat", () => {
    const state = bootGameToMain(3202);
    state.rng = { next: () => 0.0, getState: () => 0, setState: () => {}, int: () => 0 } as GameState["rng"];

    const attacker = makePokemonInPlay(mkBasic("zyg", { name: "Mega Zygarde ex", types: ["Fighting"] }));
    state.players.p1.active = attacker;

    const resActive = makePokemonInPlay({
      ...mkBasic("def", { name: "ResistActive", hp: 200 }),
      resistances: [{ type: "Fighting", value: "-30" }],
    } as PokemonCard);
    const resBench = makePokemonInPlay({
      ...mkBasic("benchDef", { name: "BenchDef", hp: 200 }),
      resistances: [{ type: "Fighting", value: "-30" }],
    } as PokemonCard);
    state.players.p2.active = resActive;
    state.players.p2.bench = [resBench];

    const move = {
      name: "Nullifying Zero",
      cost: [],
      damage: 0,
      effects: [{ kind: "multiCoinPerOppPokemon" as const, damagePerHeads: 150 }],
    };
    const res = resolveAttackEffects(state, {
      attacker,
      attackerOwner: "p1",
      defender: resActive,
      defenderOwner: "p2",
      move,
      damage: 0,
    });
    res.postDamage?.();

    // Active: 150 - 30 resistance = 120.
    expect(resActive.damage).toBe(120);
    // Bench: 150 flat.
    expect(resBench.damage).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// 4. Lunar Cycle — cross-copy once-per-turn lock
// ---------------------------------------------------------------------------

describe("Lunar Cycle (Lunatone) cross-copy lock", () => {
  function buildLunatone(): PokemonCard {
    return {
      id: "lunatone-meg-74",
      name: "Lunatone",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 90,
      types: ["Psychic"],
      attacks: [
        { name: "Power Gem", cost: ["Psychic", "Colorless"], damage: 50, text: "" },
      ],
      retreatCost: ["Colorless"],
      abilities: annotateAbilities([
        {
          name: "Lunar Cycle",
          type: "Ability",
          text: "Once during your turn, if you have Solrock in play, you may discard a Basic Fighting Energy from your hand. If you do, draw 3 cards. You can't use more than 1 Lunar Cycle Ability each turn.",
        },
      ]),
    } as PokemonCard;
  }

  function mkFightingEnergy(): EnergyCard {
    return {
      id: "fighting-energy",
      name: "Fighting Energy",
      supertype: "Energy",
      subtypes: ["Basic"],
      provides: ["Fighting"],
      text: "Provides Fighting Energy.",
    } as EnergyCard;
  }

  it("second Lunatone activation in the same turn is rejected", () => {
    const state = bootGameToMain(3301);
    const lunaCard = buildLunatone();
    const solrockCard: PokemonCard = mkBasic("solrock", { name: "Solrock", types: ["Psychic"], hp: 80 });

    state.players.p1.isAI = false;
    state.players.p1.active = makePokemonInPlay(solrockCard);
    const lunaA = makePokemonInPlay(lunaCard);
    const lunaB = makePokemonInPlay(lunaCard);
    state.players.p1.bench = [lunaA, lunaB];

    // Two Fighting energies in hand for two attempted Lunar Cycles.
    state.players.p1.hand = [mkFightingEnergy(), mkFightingEnergy()];

    // Stack the deck so each Lunar Cycle can find 3 cards to draw.
    state.players.p1.deck = Array.from({ length: 10 }, (_, i) => mkBasic(`stub-${i}`));

    // First activation succeeds.
    const r1 = activateAbility(state, "p1", lunaA.instanceId, 0);
    expect(r1.ok).toBe(true);
    expect(lunaA.abilityUsedThisTurn).toBe(true);
    // 1 energy discarded + 3 drawn = hand should be 1 (1 leftover energy) + 3 drawn = 4.
    expect(state.players.p1.hand.length).toBe(4);

    // Second activation on the OTHER Lunatone must be rejected (cross-copy lock).
    const r2 = activateAbility(state, "p1", lunaB.instanceId, 0);
    expect(r2.ok).toBe(false);
    expect((r2 as { reason: string }).reason).toMatch(/Lunar Cycle/i);
    expect(lunaB.abilityUsedThisTurn).toBe(false);
    // No second energy was discarded; no second draw of 3 happened.
    expect(state.players.p1.hand.length).toBe(4);
  });
});
