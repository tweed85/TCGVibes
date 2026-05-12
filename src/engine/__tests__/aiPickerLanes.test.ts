// Phase 0 AI picker lanes — one scenario per card where two legal targets
// exist and only one is strategically correct. Assertions check the chosen
// target (or the resulting board state), not the raw score number.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
} from "../rules";
import { applyTrainerEffect } from "../trainerEffects";
import { useStadium } from "../stadiumActivated";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  Card,
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
  state.turn = 2;
  return state;
}

const mkCard = (name: string, sup: Card["supertype"], extras: Partial<Card> = {}): Card => ({
  id: `${sup}-${name}`,
  name,
  supertype: sup,
  subtypes: [],
  ...extras,
} as Card);

const mkBasicEnergy = (type: string): EnergyCard => ({
  id: `e-${type}-${Math.random().toString(36).slice(2, 7)}`,
  name: `Basic ${type} Energy`,
  supertype: "Energy",
  subtypes: ["Basic"],
  provides: [type as never],
} as EnergyCard);

const mkItemCard = (name: string, effectId: string): TrainerCard => ({
  id: `i-${name}`,
  name,
  supertype: "Trainer",
  subtypes: ["Item"],
  text: "...",
  effectId,
} as TrainerCard);

const mkPokemon = (
  name: string,
  opts: {
    hp?: number;
    types?: string[];
    subtypes?: string[];
    attacks?: { name?: string; cost: string[]; damage?: number }[];
    evolvesFrom?: string;
  } = {},
): PokemonCard =>
  ({
    id: `p-${name}`,
    name,
    supertype: "Pokémon",
    subtypes: opts.subtypes ?? ["Basic"],
    hp: opts.hp ?? 80,
    types: opts.types ?? ["Colorless"],
    attacks: (opts.attacks ?? []).map((a, i) => ({
      name: a.name ?? `Attack-${i}`,
      cost: a.cost,
      damage: a.damage ?? 0,
    })),
    weaknesses: [],
    resistances: [],
    retreatCost: ["Colorless"],
    evolvesFrom: opts.evolvesFrom,
  }) as unknown as PokemonCard;

const mkInPlay = (card: PokemonCard, opts: { id?: string; energy?: EnergyCard[]; damage?: number } = {}): PokemonInPlay =>
  ({
    instanceId: opts.id ?? `inst-${card.name}-${Math.random().toString(36).slice(2, 7)}`,
    card,
    damage: opts.damage ?? 0,
    attachedEnergy: opts.energy ?? [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  }) as PokemonInPlay;

describe("Prime Catcher — AI prefers KO target over highest-HP", () => {
  it("AI gusts the bench Pokémon it can OHKO instead of the higher-HP one", () => {
    const state = bootGameToMain(101);
    const ap = state.activePlayer;
    const op = ap === "p1" ? "p2" : "p1";
    state.players[ap].isAI = true;
    // Our Active: 1 Energy attached, 60-damage attack for 1 Energy.
    const ourAttacker = mkPokemon("Striker", {
      hp: 100,
      attacks: [{ name: "Punch", cost: ["Colorless"], damage: 60 }],
    });
    state.players[ap].active = mkInPlay(ourAttacker, { energy: [mkBasicEnergy("Colorless")] });
    // Opp Active and bench setup:
    //   Opp Active = something we can't reach
    //   Bench A = 200 HP (high), no damage
    //   Bench B = 50 HP (we can KO with Punch)
    state.players[op].active = mkInPlay(
      mkPokemon("Active Wall", { hp: 220 }),
      { id: "opp-active" },
    );
    state.players[op].bench = [
      mkInPlay(mkPokemon("Tank", { hp: 200 }), { id: "tank" }),
      mkInPlay(mkPokemon("Glass Cannon", { hp: 50 }), { id: "glass" }),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Prime Catcher", "primeCatcher"));
    // After gust, Active should be the KO-able target.
    expect(state.players[op].active!.instanceId).toBe("glass");
  });
});

describe("Precious Trolley — AI prefers Basics with evolution in library", () => {
  it("AI benches Basics whose Stage 1 sits in the deck over filler Basics", () => {
    const state = bootGameToMain(110);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].bench = [];
    // Two Basics with evolutions in deck, one filler Basic without.
    state.players[ap].deck = [
      mkCard("Filler-A", "Pokémon", { subtypes: ["Basic"], hp: 60 } as Partial<Card>),
      mkPokemon("Dreepy", { hp: 60 }) as unknown as Card,
      mkPokemon("Drakloak", { evolvesFrom: "Dreepy", subtypes: ["Stage 1"] }) as unknown as Card,
      mkPokemon("Sprigatito", { hp: 60 }) as unknown as Card,
      mkPokemon("Floragato", { evolvesFrom: "Sprigatito", subtypes: ["Stage 1"] }) as unknown as Card,
    ];
    // Bench full minus 2: only 2 slots open, 3 Basics in deck — AI must pick best 2.
    state.players[ap].bench = [
      mkInPlay(mkPokemon("Holder1")),
      mkInPlay(mkPokemon("Holder2")),
      mkInPlay(mkPokemon("Holder3")),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Precious Trolley", "searchAnyBasicsToBench"));
    const benchedNames = state.players[ap].bench.slice(3).map((p) => p.card.name);
    expect(benchedNames).toContain("Dreepy");
    expect(benchedNames).toContain("Sprigatito");
    expect(benchedNames).not.toContain("Filler-A");
  });
});

describe("Energy Search Pro — AI prefers wanted types first", () => {
  it("Pulls Fire (wanted by attacker) over Water before falling back to other types", () => {
    const state = bootGameToMain(120);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Active wants Fire (single non-Colorless cost slot).
    state.players[ap].active = mkInPlay(
      mkPokemon("Fire Striker", {
        attacks: [{ cost: ["Fire", "Colorless"], damage: 60 }],
      }),
    );
    // Deck has multiple types but only one slot of each.
    state.players[ap].deck = [
      mkBasicEnergy("Water"),
      mkBasicEnergy("Fire"),
      mkBasicEnergy("Lightning"),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Energy Search Pro", "searchEnergyVariety"));
    const handTypes = state.players[ap].hand
      .filter((c): c is EnergyCard => c.supertype === "Energy")
      .map((e) => e.provides[0]);
    // Fire MUST be in the pulled set (wanted type).
    expect(handTypes).toContain("Fire");
  });
});

describe("Glass Trumpet — AI matches Energy type to target's needs", () => {
  it("Attaches Fire to the Fire-wanting Colorless target, not the Water-wanting one", () => {
    const state = bootGameToMain(130);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Need a Tera Pokémon in play for the gate.
    state.players[ap].active = mkInPlay(
      mkPokemon("Tera Holder", { subtypes: ["Basic", "Tera"] }),
    );
    // Two Bench Colorless targets with different non-Colorless cost needs.
    const fireWantsTarget = mkInPlay(
      mkPokemon("Fire Wanter", {
        types: ["Colorless"],
        attacks: [{ cost: ["Fire", "Colorless"], damage: 80 }],
      }),
      { id: "fire-want" },
    );
    const waterWantsTarget = mkInPlay(
      mkPokemon("Water Wanter", {
        types: ["Colorless"],
        attacks: [{ cost: ["Water", "Colorless"], damage: 80 }],
      }),
      { id: "water-want" },
    );
    state.players[ap].bench = [fireWantsTarget, waterWantsTarget];
    state.players[ap].discard = [
      mkBasicEnergy("Fire"),
      mkBasicEnergy("Lightning"), // not wanted by either target
    ];
    applyTrainerEffect(state, ap, mkItemCard("Glass Trumpet", "glassTrumpet"));
    // Fire Wanter should have received the Fire Energy.
    const fireProvides = fireWantsTarget.attachedEnergy.flatMap((e) => e.provides);
    expect(fireProvides).toContain("Fire");
  });
});

describe("Scramble Switch — AI picks the bench that becomes strongest", () => {
  it("Switches to the higher-damage bench Pokémon, not bench[0]", () => {
    const state = bootGameToMain(140);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].active = mkInPlay(
      mkPokemon("Old Active", { attacks: [{ cost: ["Colorless"], damage: 30 }] }),
      { energy: [mkBasicEnergy("Colorless"), mkBasicEnergy("Colorless")] },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemon("Weak Bench", { attacks: [{ cost: ["Colorless"], damage: 30 }] }),
        { id: "weak" },
      ),
      mkInPlay(
        mkPokemon("Strong Bench", { attacks: [{ cost: ["Colorless"], damage: 200 }] }),
        { id: "strong" },
      ),
    ];
    applyTrainerEffect(state, ap, mkItemCard("Scramble Switch", "scrambleSwitch"));
    expect(state.players[ap].active!.instanceId).toBe("strong");
  });
});

describe("Academy at Night — AI stashes the least immediately useful card", () => {
  it("Puts back a duplicate Pokémon in hand instead of a unique evolution piece", () => {
    const state = bootGameToMain(150);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    const inPlayName = state.players[ap].active!.card.name;
    // Hand contains: a duplicate of in-play Pokémon (low value) and a unique
    // evolution piece (high value to keep).
    state.players[ap].hand = [
      mkPokemon(inPlayName) as unknown as Card,
      mkPokemon("Unique Evo", { subtypes: ["Stage 1"], evolvesFrom: "X" }) as unknown as Card,
    ];
    state.stadium = {
      card: mkCard("Academy at Night", "Trainer", {
        subtypes: ["Stadium"],
      }) as TrainerCard,
      controller: ap,
    };
    const r = useStadium(state, ap);
    expect(r.ok).toBe(true);
    // Top of deck should be the duplicate Pokémon (lower-value stash).
    expect(state.players[ap].deck[0].name).toBe(inPlayName);
  });
});

describe("Prism Tower — AI protects setup pieces from discard", () => {
  it("Discards a duplicate Energy + a non-Supporter Trainer over a unique evolution piece", () => {
    const state = bootGameToMain(160);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Make eligible-Basic in play (so the evolution piece is "wanted").
    state.players[ap].active = mkInPlay(
      mkPokemon("Bulbasaur", { hp: 70 }),
    );
    state.players[ap].hand = [
      mkBasicEnergy("Lightning"), // unwanted type — fine to discard
      mkBasicEnergy("Lightning"), // duplicate — fine to discard
      mkPokemon("Ivysaur", { subtypes: ["Stage 1"], evolvesFrom: "Bulbasaur" }) as unknown as Card,
    ];
    state.players[ap].deck = [mkCard("FillerDraw", "Trainer", { subtypes: ["Item"] })];
    state.stadium = {
      card: mkCard("Prism Tower", "Trainer", {
        subtypes: ["Stadium"],
      }) as TrainerCard,
      controller: ap,
    };
    const r = useStadium(state, ap);
    expect(r.ok).toBe(true);
    // The unique Stage 1 must NOT be in the discard pile.
    const discardedNames = state.players[ap].discard.map((c) => c.name);
    expect(discardedNames).not.toContain("Ivysaur");
    // Both Lightning Energy should have been discarded.
    const lightningDiscards = state.players[ap].discard.filter(
      (c) => c.supertype === "Energy",
    );
    expect(lightningDiscards.length).toBe(2);
  });
});

describe("Mystery Garden — AI discards least-needed Energy type", () => {
  it("Discards an unwanted Lightning Energy over a wanted Fire Energy", () => {
    const state = bootGameToMain(170);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Active is Psychic (so Mystery Garden's draw target = 1).
    state.players[ap].active = mkInPlay(
      mkPokemon("Fire Striker", {
        types: ["Psychic"], // Psychic for Mystery Garden gate
        attacks: [{ cost: ["Fire", "Colorless"], damage: 80 }],
      }),
    );
    state.players[ap].hand = [
      mkBasicEnergy("Lightning"), // unwanted
      mkBasicEnergy("Fire"), // wanted
    ];
    state.players[ap].deck = [mkCard("DrawA", "Trainer", { subtypes: ["Item"] })];
    state.stadium = {
      card: mkCard("Mystery Garden", "Trainer", {
        subtypes: ["Stadium"],
      }) as TrainerCard,
      controller: ap,
    };
    const r = useStadium(state, ap);
    expect(r.ok).toBe(true);
    const discardedTypes = state.players[ap].discard
      .filter((c): c is EnergyCard => c.supertype === "Energy")
      .map((e) => e.provides[0]);
    expect(discardedTypes).toContain("Lightning");
    expect(discardedTypes).not.toContain("Fire");
  });
});

describe("Levincia — AI skips activation when Lightning has no use", () => {
  it("Does not pull Lightning Energy when no attacker has Lightning or Colorless cost", () => {
    const state = bootGameToMain(180);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Active uses pure Fire+Psychic costs — no Lightning, no Colorless.
    state.players[ap].active = mkInPlay(
      mkPokemon("PureFireStriker", {
        attacks: [{ cost: ["Fire", "Fire", "Psychic"], damage: 100 }],
      }),
    );
    state.players[ap].bench = [];
    state.players[ap].discard = [
      mkBasicEnergy("Lightning"),
      mkBasicEnergy("Lightning"),
    ];
    state.stadium = {
      card: mkCard("Levincia", "Trainer", {
        subtypes: ["Stadium"],
      }) as TrainerCard,
      controller: ap,
    };
    const r = useStadium(state, ap);
    expect(r.ok).toBe(true);
    // No Lightning should be in hand — AI should have skipped.
    const handLightning = state.players[ap].hand.filter(
      (c) =>
        c.supertype === "Energy" &&
        (c as EnergyCard).provides.includes("Lightning" as never),
    );
    expect(handLightning).toHaveLength(0);
  });

  it("Pulls Lightning when a bench attacker has a Colorless cost slot", () => {
    const state = bootGameToMain(181);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Active: pure Fire (no Lightning use)
    state.players[ap].active = mkInPlay(
      mkPokemon("PureFireStriker", {
        attacks: [{ cost: ["Fire", "Fire"], damage: 100 }],
      }),
    );
    // Bench has a Colorless-cost attacker — Lightning can fuel Colorless.
    state.players[ap].bench = [
      mkInPlay(
        mkPokemon("ColorlessAttacker", {
          attacks: [{ cost: ["Colorless", "Colorless"], damage: 60 }],
        }),
      ),
    ];
    state.players[ap].discard = [
      mkBasicEnergy("Lightning"),
      mkBasicEnergy("Lightning"),
    ];
    state.stadium = {
      card: mkCard("Levincia", "Trainer", {
        subtypes: ["Stadium"],
      }) as TrainerCard,
      controller: ap,
    };
    const r = useStadium(state, ap);
    expect(r.ok).toBe(true);
    const handLightning = state.players[ap].hand.filter(
      (c) =>
        c.supertype === "Energy" &&
        (c as EnergyCard).provides.includes("Lightning" as never),
    );
    expect(handLightning.length).toBeGreaterThan(0);
  });
});

describe("Surfing Beach — AI picks most-charged Water bench", () => {
  it("Switches to the bench Water Pokémon with more attached Energy", () => {
    const state = bootGameToMain(190);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].active = mkInPlay(
      mkPokemon("Active Water", { types: ["Water"] }),
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemon("WeakWater", {
          types: ["Water"],
          attacks: [{ cost: ["Water"], damage: 30 }],
        }),
        { id: "weak", energy: [] },
      ),
      mkInPlay(
        mkPokemon("StrongWater", {
          types: ["Water"],
          attacks: [{ cost: ["Water", "Water"], damage: 120 }],
        }),
        {
          id: "strong",
          energy: [mkBasicEnergy("Water"), mkBasicEnergy("Water")],
        },
      ),
    ];
    state.stadium = {
      card: mkCard("Surfing Beach", "Trainer", {
        subtypes: ["Stadium"],
      }) as TrainerCard,
      controller: ap,
    };
    const r = useStadium(state, ap);
    expect(r.ok).toBe(true);
    expect(state.players[ap].active!.instanceId).toBe("strong");
  });
});

describe("Grand Tree — AI evolves the chosen line through Stage 2", () => {
  it("Evolves Basic → Stage 1 → Stage 2 in one resolution when both are in deck", () => {
    const state = bootGameToMain(200);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].active = mkInPlay(mkPokemon("Bulbasaur"));
    state.players[ap].bench = [];
    state.players[ap].deck = [
      mkPokemon("Ivysaur", { subtypes: ["Stage 1"], evolvesFrom: "Bulbasaur" }) as unknown as Card,
      mkPokemon("Venusaur", { hp: 160, subtypes: ["Stage 2"], evolvesFrom: "Ivysaur" }) as unknown as Card,
      mkCard("FillerCard", "Trainer", { subtypes: ["Item"] }),
    ];
    state.stadium = {
      card: mkCard("Grand Tree", "Trainer", {
        subtypes: ["Stadium"],
      }) as TrainerCard,
      controller: ap,
    };
    const r = useStadium(state, ap);
    expect(r.ok).toBe(true);
    expect(state.players[ap].active!.card.name).toBe("Venusaur");
  });
});
