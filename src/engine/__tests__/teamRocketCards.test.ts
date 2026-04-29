// Regression tests for three Team Rocket card bugs reported during a TR
// Mewtwo deck playtest:
//   - Spidops Rocket Rush over-damage (base 30 retained on top of "30×"
//     per-TR-Pokémon scaler → 30 + 30×N instead of 30×N).
//   - Team Rocket's Ariana drew to 5 even when all in-play were TR
//     (should draw to 8 in that case).
//   - Team Rocket's Proton blocked on the going-first player's first turn
//     (the card explicitly grants a T1 exception).

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  isBasic,
  isPokemon,
  completeSetup,
} from "../rules";
import { attack, playTrainer } from "../actions";
import { applyTrainerEffect } from "../trainerEffects";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  EnergyCard,
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

const E = (type: string): EnergyCard => ({
  id: `e-${type.toLowerCase()}`,
  name: `Basic ${type} Energy`,
  supertype: "Energy",
  subtypes: ["Basic"],
  provides: [type as never],
} as EnergyCard);

const mkBenchTR = (idSuffix: string, name = "Team Rocket's Spidops"): PokemonInPlay => ({
  instanceId: `tr-${idSuffix}`,
  card: {
    id: `tr-${idSuffix}`,
    name,
    supertype: "Pokémon",
    subtypes: ["Basic"],
    hp: 80,
    types: ["Colorless"],
    attacks: [],
    retreatCost: [],
  } as PokemonCard,
  damage: 0,
  attachedEnergy: [],
  evolvedFrom: [],
  tools: [],
  playedThisTurn: false,
  evolvedThisTurn: false,
  statuses: [],
  abilityUsedThisTurn: false,
} as PokemonInPlay);

// ---------------------------------------------------------------------------
// Bug 3 — Spidops Rocket Rush damage = 30 × (count of TR in play), not 30 + ...
// ---------------------------------------------------------------------------

describe("extractEffects: 'N× damage for each of your X Pokémon in play' zeros base", () => {
  it("multiplicative form (damage='30×') sets baseDamageOverride=0", async () => {
    const { extractEffects } = await import("../../data/effectPatterns");
    const r = extractEffects({
      name: "Rocket Rush",
      cost: [],
      damage: "30×",
      text: "This attack does 30 damage for each of your Team Rocket's Pokémon in play.",
    });
    // The fix: multiplicative match → baseDamageOverride === 0.
    expect(r.baseDamageOverride).toBe(0);
    // perPokemonFilter effect was emitted with the right scaler.
    const eff = r.effects.find((e) => e.kind === "perPokemonFilter") as
      | { kind: "perPokemonFilter"; perCount: number; filter: { kind: string; namePart?: string } }
      | undefined;
    expect(eff?.perCount).toBe(30);
    expect(eff?.filter.kind).toBe("namePart");
    // parsePokemonFilter lowercases its input; the downstream check at
    // effects.ts:perPokemonFilter compares case-insensitively, so the
    // stored value is intentionally lowercase.
    expect(eff?.filter.namePart?.toLowerCase()).toBe("team rocket's");
  });

  it("additive form (damage='30+') keeps baseDamageOverride undefined", async () => {
    const { extractEffects } = await import("../../data/effectPatterns");
    const r = extractEffects({
      name: "Hypothetical",
      cost: [],
      damage: "30+",
      text: "This attack does 30 more damage for each of your Pokémon in play.",
    });
    // Additive match must NOT zero the base — base + N×count is the
    // intended semantics ("N+" suffix).
    expect(r.baseDamageOverride).toBeUndefined();
    const eff = r.effects.find((e) => e.kind === "perPokemonFilter");
    expect(eff).toBeDefined();
  });
});

describe("Team Rocket's Spidops Rocket Rush — runtime damage", () => {
  it("with 6 TR Pokémon in play, deals exactly 180 (not 210)", () => {
    const state = bootGameToMain(101);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";

    // Spidops as Active with the Rocket Rush attack pattern.
    state.players[ap].active!.card = {
      id: "spidops-test",
      name: "Team Rocket's Spidops",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 100,
      types: ["Grass"],
      attacks: [
        {
          name: "Rocket Rush",
          cost: [],
          // damage = 0 because extractEffects sets baseDamageOverride=0
          // for the multiplicative "N×" form; the displayed damageText
          // is still "30×" for UI but the engine sees 0 + 30×count.
          damage: 0,
          damageText: "30×",
          // Use the 'perPokemonFilter' effect kind — the same one
          // effectPatterns.ts builds for this attack text. perCount=30,
          // includeActive=true, namePart="Team Rocket's".
          effects: [
            {
              kind: "perPokemonFilter",
              side: "friendly",
              perCount: 30,
              filter: { kind: "namePart", namePart: "Team Rocket's" },
              includeActive: true,
            },
          ],
        },
      ],
      retreatCost: [],
    } as PokemonCard;
    state.players[ap].active!.attachedEnergy = [];

    // Bench: 5 more TR Pokémon = 6 total in play (active + 5 bench).
    state.players[ap].bench = [
      mkBenchTR("a"),
      mkBenchTR("b"),
      mkBenchTR("c"),
      mkBenchTR("d"),
      mkBenchTR("e"),
    ];

    // Defender: 210 HP, no Grass weakness — Teal-Mask-Ogerpon-equivalent.
    state.players[opp].active!.card = {
      id: "tank",
      name: "Tank",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 210,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    } as PokemonCard;
    state.players[opp].active!.damage = 0;

    // Disable per-attack rng (no coin flips on this attack anyway).
    attack(state, ap, 0);

    // Defender should have taken exactly 180. Damage = 30 × 6 (no base).
    const def = state.players[opp].active!;
    expect(def.damage).toBe(180);
    // Target survives.
    expect(state.winner).toBeNull();
  });

  it("with 7 TR Pokémon in play, deals 210 — KOs the 210 HP target", () => {
    const state = bootGameToMain(102);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";

    state.players[ap].active!.card = {
      id: "spidops-test-7",
      name: "Team Rocket's Spidops",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 100,
      types: ["Grass"],
      attacks: [
        {
          name: "Rocket Rush",
          cost: [],
          // damage = 0 because extractEffects sets baseDamageOverride=0
          // for the multiplicative "N×" form; the displayed damageText
          // is still "30×" for UI but the engine sees 0 + 30×count.
          damage: 0,
          damageText: "30×",
          effects: [
            {
              kind: "perPokemonFilter",
              side: "friendly",
              perCount: 30,
              filter: { kind: "namePart", namePart: "Team Rocket's" },
              includeActive: true,
            },
          ],
        },
      ],
      retreatCost: [],
    } as PokemonCard;

    // 1 active + 6 bench (max bench is 5; we patch the engine cap by
    // bumping it for the test if needed — actually we'll use 5 bench to
    // hit 6 in play first, then add a 7th by raising bench cap here).
    // The engine enforces bench≤5 at play time, but mutating `bench`
    // directly bypasses that gate (which is the test's intent).
    state.players[ap].bench = [
      mkBenchTR("a"),
      mkBenchTR("b"),
      mkBenchTR("c"),
      mkBenchTR("d"),
      mkBenchTR("e"),
      mkBenchTR("f"),
    ];

    state.players[opp].active!.card = {
      id: "tank-2",
      name: "Tank",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 210,
      types: ["Colorless"],
      attacks: [],
      retreatCost: [],
    } as PokemonCard;
    state.players[opp].active!.damage = 0;

    attack(state, ap, 0);
    // 30 × 7 = 210, target KO'd. After attack, opp's active is null
    // (KO triggered promote pause) OR replaced via promote.
    const oppKoOrPromoted = state.players[opp].active === null ||
      state.players[opp].active?.card.name !== "Tank";
    expect(oppKoOrPromoted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — Ariana draws to 8 when all in-play are TR Pokémon, else 5
// ---------------------------------------------------------------------------

describe("Team Rocket's Ariana — draws to 5 or 8 conditionally", () => {
  const ariana = (): TrainerCard => ({
    id: "ariana-test",
    name: "Team Rocket's Ariana",
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId: "arianaDrawUntilTR",
  } as TrainerCard);

  it("all in-play are TR → draws until hand has 8", () => {
    const state = bootGameToMain(201);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      ...state.players[ap].active!.card,
      name: "Team Rocket's Mewtwo",
    } as PokemonCard;
    state.players[ap].bench = [mkBenchTR("a"), mkBenchTR("b")];
    // Hand starts at 3 (deterministic from boot), but force to 3 for the
    // draw-target check.
    state.players[ap].hand = state.players[ap].hand.slice(0, 3);
    const before = state.players[ap].hand.length;

    applyTrainerEffect(state, ap, ariana());

    expect(state.players[ap].hand.length).toBe(8);
    expect(before).toBe(3);
  });

  it("not all in-play are TR → draws until hand has 5", () => {
    const state = bootGameToMain(202);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      ...state.players[ap].active!.card,
      name: "Team Rocket's Mewtwo",
    } as PokemonCard;
    // Mix in a non-TR bench Pokémon — disqualifies the all-TR clause.
    state.players[ap].bench = [
      mkBenchTR("a"),
      mkBenchTR("b", "Pikachu"), // non-TR
    ];
    state.players[ap].hand = state.players[ap].hand.slice(0, 2);

    applyTrainerEffect(state, ap, ariana());

    expect(state.players[ap].hand.length).toBe(5);
  });

  it("hand already at or above target → no-op (doesn't shrink)", () => {
    const state = bootGameToMain(203);
    const ap = state.activePlayer;
    state.players[ap].active!.card = {
      ...state.players[ap].active!.card,
      name: "Team Rocket's Mewtwo",
    } as PokemonCard;
    state.players[ap].bench = [mkBenchTR("a")];
    // Hand already has 9 — Ariana with all-TR target=8 → draw 0.
    state.players[ap].hand = Array(9).fill(E("Fire"));

    applyTrainerEffect(state, ap, ariana());

    expect(state.players[ap].hand.length).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Bug 1 — Proton playable on first player's T1
// ---------------------------------------------------------------------------

describe("Team Rocket's Proton — T1 exception", () => {
  const proton = (): TrainerCard => ({
    id: "proton-test",
    name: "Team Rocket's Proton",
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId: "protonSearchBasicTR",
  } as TrainerCard);

  const iono = (): TrainerCard => ({
    id: "iono-test",
    name: "Iono",
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId: "shuffleHandDrawN",
  } as TrainerCard);

  it("first player's T1 ban is bypassed for Proton", () => {
    const state = bootGameToMain(301);
    const ap = state.activePlayer;
    state.firstTurnNoAttack = true;
    state.turn = 1;
    state.players[ap].hand = [proton(), ...state.players[ap].hand];
    // Seed a Basic TR Pokémon in deck so the search succeeds.
    state.players[ap].deck.unshift({
      id: "tr-mewtwo",
      name: "Team Rocket's Mewtwo",
      supertype: "Pokémon",
      subtypes: ["Basic"],
      hp: 70,
      types: ["Psychic"],
      attacks: [],
      retreatCost: [],
    } as PokemonCard);
    const r = playTrainer(state, ap, 0);
    expect(r.ok).toBe(true);
  });

  it("first player's T1 ban still rejects other Supporters (Iono)", () => {
    const state = bootGameToMain(302);
    const ap = state.activePlayer;
    state.firstTurnNoAttack = true;
    state.turn = 1;
    state.players[ap].hand = [iono(), ...state.players[ap].hand];
    const r = playTrainer(state, ap, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/first turn/i);
  });

  it("Proton's effect: search up to 3 Basic Team Rocket's Pokémon", () => {
    const state = bootGameToMain(303);
    const ap = state.activePlayer;
    // Seed deck with mixed candidates: 2 TR Basics + 1 non-TR Basic.
    const trA: PokemonCard = {
      id: "tr-mewtwo-a", name: "Team Rocket's Mewtwo",
      supertype: "Pokémon", subtypes: ["Basic"], hp: 70,
      types: ["Psychic"], attacks: [], retreatCost: [],
    } as PokemonCard;
    const trB: PokemonCard = {
      id: "tr-spidops-b", name: "Team Rocket's Spidops",
      supertype: "Pokémon", subtypes: ["Basic"], hp: 80,
      types: ["Grass"], attacks: [], retreatCost: [],
    } as PokemonCard;
    const nonTr: PokemonCard = {
      id: "pikachu-c", name: "Pikachu",
      supertype: "Pokémon", subtypes: ["Basic"], hp: 60,
      types: ["Lightning"], attacks: [], retreatCost: [],
    } as PokemonCard;
    state.players[ap].deck = [trA, trB, nonTr, ...state.players[ap].deck];

    applyTrainerEffect(state, ap, proton());
    // Proton opens an interactive pick — the engine sets pendingPick on
    // a deck-search Trainer. The pool should contain only the 2 TR
    // candidates (not Pikachu).
    expect(state.pendingPick).not.toBeNull();
    const trCandidates = state.pendingPick!.pool.filter(
      (c) => c.name.toLowerCase().startsWith("team rocket's"),
    );
    expect(trCandidates.length).toBe(2);
    const nonTrInPool = state.pendingPick!.pool.find((c) => c.name === "Pikachu");
    expect(nonTrInPool).toBeUndefined();
  });
});
