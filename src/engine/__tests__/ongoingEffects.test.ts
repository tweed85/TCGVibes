// Stadium / Tool passive modifier tests. We construct minimal mock objects
// rather than loading the whole card dataset so the tests stay fast and
// independent of card-data changes.

import { describe, it, expect } from "vitest";
import {
  effectiveMaxHp,
  effectiveRetreatCost,
  maxBenchSize,
  toolsActive,
  isStatusImmune,
  stadiumAttackBonus,
  stadiumDamageReduction,
  effectiveAttackCost,
  estimateAttackDamage,
  prizeReductionFromTools,
  applySurvivalBrace,
  passiveAttackBonus,
} from "../ongoingEffects";
import type {
  GameState,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "../types";

function mkPokemon(overrides: Partial<PokemonCard> = {}): PokemonCard {
  return {
    id: "test",
    name: "Test",
    supertype: "Pokémon",
    subtypes: ["Basic"],
    hp: 100,
    types: ["Colorless"],
    attacks: [],
    retreatCost: ["Colorless"],
    ...overrides,
  } as PokemonCard;
}

function mkInPlay(card: PokemonCard, overrides: Partial<PokemonInPlay> = {}): PokemonInPlay {
  return {
    instanceId: "p-test",
    card,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
    ...overrides,
  };
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

function mkTool(name: string): TrainerCard {
  return {
    id: `tool-${name}`,
    name,
    supertype: "Trainer",
    subtypes: ["Pokémon Tool"],
    text: "",
  } as TrainerCard;
}

function mkState(overrides: Partial<GameState> = {}): GameState {
  const emptyPlayer = {
    id: "p1" as const,
    name: "P1",
    deck: [],
    hand: [],
    discard: [],
    prizes: [],
    bench: [],
    active: null,
    energyAttachedThisTurn: false,
    supporterPlayedThisTurn: false,
    retreatedThisTurn: false,
    mulligans: 0,
    setupComplete: false,
    thisTurnAttackBonuses: [],
    nextOpponentTurnDamageReductions: [],
    itemsBlockedNextTurn: false,
    isAI: false,
  };
  return {
    players: {
      p1: { ...emptyPlayer, id: "p1", name: "P1" },
      p2: { ...emptyPlayer, id: "p2", name: "P2" },
    },
    activePlayer: "p1",
    turn: 1,
    phase: "main",
    winner: null,
    log: [],
    firstTurnNoAttack: false,
    stadium: null,
    pendingPromote: null,
    pendingPromoteQueue: [],
    pendingHeavyBaton: null,
    onPromoteResolved: null,
    pendingSecondAttack: null,
    pendingPick: null,
    coinFlip: null,
    rng: {
      next: () => 0.5,
      int: (n) => Math.floor(0.5 * n),
      getState: () => 0,
      setState: () => {},
    },
    ...overrides,
  } as GameState;
}

describe("effectiveMaxHp — HP modifiers", () => {
  it("base HP with no stadium / tools", () => {
    const p = mkInPlay(mkPokemon({ hp: 100 }));
    expect(effectiveMaxHp(p, mkState())).toBe(100);
  });

  it("Lively Stadium adds +30 to Basics", () => {
    const p = mkInPlay(mkPokemon({ hp: 100, subtypes: ["Basic"] }));
    const s = mkState({ stadium: { card: mkStadium("Lively Stadium"), controller: "p1" } });
    expect(effectiveMaxHp(p, s)).toBe(130);
  });

  it("Lively Stadium does NOT add to Stage 1", () => {
    const p = mkInPlay(mkPokemon({ hp: 100, subtypes: ["Stage 1"] }));
    const s = mkState({ stadium: { card: mkStadium("Lively Stadium"), controller: "p1" } });
    expect(effectiveMaxHp(p, s)).toBe(100);
  });

  it("Gravity Mountain subtracts 30 from Stage 2", () => {
    const p = mkInPlay(mkPokemon({ hp: 140, subtypes: ["Stage 2"] }));
    const s = mkState({ stadium: { card: mkStadium("Gravity Mountain"), controller: "p2" } });
    expect(effectiveMaxHp(p, s)).toBe(110);
  });

  it("Hero's Cape adds +100 HP", () => {
    const p = mkInPlay(mkPokemon({ hp: 120 }), { tools: [mkTool("Hero's Cape")] });
    expect(effectiveMaxHp(p, mkState())).toBe(220);
  });

  it("Jamming Tower disables Tool HP bonus", () => {
    const p = mkInPlay(mkPokemon({ hp: 120 }), { tools: [mkTool("Hero's Cape")] });
    const s = mkState({ stadium: { card: mkStadium("Jamming Tower"), controller: "p2" } });
    expect(effectiveMaxHp(p, s)).toBe(120); // tool ignored
  });

  it("stacks Stadium + Tool bonuses", () => {
    const p = mkInPlay(mkPokemon({ hp: 120, subtypes: ["Basic"] }), {
      tools: [mkTool("Hero's Cape")],
    });
    const s = mkState({ stadium: { card: mkStadium("Lively Stadium"), controller: "p1" } });
    expect(effectiveMaxHp(p, s)).toBe(120 + 30 + 100);
  });

  it("HP never drops below 10", () => {
    const p = mkInPlay(mkPokemon({ hp: 30, subtypes: ["Stage 2"] }));
    const s = mkState({ stadium: { card: mkStadium("Gravity Mountain"), controller: "p2" } });
    expect(effectiveMaxHp(p, s)).toBe(10); // 30 - 30 = 0, clamped up
  });
});

describe("effectiveRetreatCost — Tool + Stadium reductions", () => {
  it("base retreat cost with no modifiers", () => {
    const p = mkInPlay(mkPokemon({ retreatCost: ["Colorless", "Colorless"] }));
    expect(effectiveRetreatCost(p)).toEqual(["Colorless", "Colorless"]);
  });

  it("Air Balloon removes 2 Colorless retreat", () => {
    const p = mkInPlay(
      mkPokemon({ retreatCost: ["Colorless", "Colorless"] }),
      { tools: [mkTool("Air Balloon")] },
    );
    expect(effectiveRetreatCost(p)).toEqual([]);
  });

  it("Rescue Board removes 1 Colorless", () => {
    const p = mkInPlay(
      mkPokemon({ retreatCost: ["Colorless", "Colorless"] }),
      { tools: [mkTool("Rescue Board")] },
    );
    expect(effectiveRetreatCost(p)).toEqual(["Colorless"]);
  });

  it("N's Castle gives N's Pokémon zero retreat", () => {
    const p = mkInPlay(mkPokemon({ name: "N's Zoroark", retreatCost: ["Colorless"] }));
    const s = mkState({ stadium: { card: mkStadium("N's Castle"), controller: "p1" } });
    expect(effectiveRetreatCost(p, s)).toEqual([]);
  });
});

describe("maxBenchSize — Area Zero Underdepths", () => {
  it("default cap is 5", () => {
    expect(maxBenchSize(mkState(), [], null)).toBe(5);
  });

  it("Area Zero + Tera in play raises cap to 8", () => {
    const tera = mkInPlay(mkPokemon({ subtypes: ["Basic", "Tera"] }));
    const s = mkState({ stadium: { card: mkStadium("Area Zero Underdepths"), controller: "p1" } });
    expect(maxBenchSize(s, [], tera)).toBe(8);
  });

  it("Area Zero without Tera stays at 5", () => {
    const basic = mkInPlay(mkPokemon({ subtypes: ["Basic"] }));
    const s = mkState({ stadium: { card: mkStadium("Area Zero Underdepths"), controller: "p1" } });
    expect(maxBenchSize(s, [], basic)).toBe(5);
  });
});

describe("toolsActive — Jamming Tower kill switch", () => {
  it("tools are active by default", () => {
    expect(toolsActive(mkState())).toBe(true);
  });

  it("Jamming Tower disables tool effects", () => {
    const s = mkState({ stadium: { card: mkStadium("Jamming Tower"), controller: "p1" } });
    expect(toolsActive(s)).toBe(false);
  });
});

describe("isStatusImmune — Festival Grounds", () => {
  it("not immune without Festival Grounds", () => {
    const p = mkInPlay(mkPokemon(), {
      attachedEnergy: [{ id: "e1", name: "Grass Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Grass"] }] as any,
    });
    expect(isStatusImmune(p, mkState())).toBe(false);
  });

  it("immune with Festival Grounds + any Energy attached", () => {
    const p = mkInPlay(mkPokemon(), {
      attachedEnergy: [{ id: "e1", name: "Grass Energy", supertype: "Energy", subtypes: ["Basic"], provides: ["Grass"] }] as any,
    });
    const s = mkState({ stadium: { card: mkStadium("Festival Grounds"), controller: "p1" } });
    expect(isStatusImmune(p, s)).toBe(true);
  });

  it("not immune with Festival Grounds but no Energy", () => {
    const p = mkInPlay(mkPokemon());
    const s = mkState({ stadium: { card: mkStadium("Festival Grounds"), controller: "p1" } });
    expect(isStatusImmune(p, s)).toBe(false);
  });
});

describe("stadiumAttackBonus — attacker-side damage add", () => {
  it("no bonus without matching stadium/tool", () => {
    const atk = mkInPlay(mkPokemon({ name: "Test" }));
    const def = mkInPlay(mkPokemon());
    expect(stadiumAttackBonus(mkState(), atk, def)).toBe(0);
  });

  it("Postwick adds +30 for Hop's Pokémon attacks", () => {
    const atk = mkInPlay(mkPokemon({ name: "Hop's Zacian" }));
    const def = mkInPlay(mkPokemon());
    const s = mkState({ stadium: { card: mkStadium("Postwick"), controller: "p1" } });
    expect(stadiumAttackBonus(s, atk, def)).toBe(30);
  });

  it("Postwick does nothing for non-Hop's attacker", () => {
    const atk = mkInPlay(mkPokemon({ name: "Miraidon" }));
    const def = mkInPlay(mkPokemon());
    const s = mkState({ stadium: { card: mkStadium("Postwick"), controller: "p1" } });
    expect(stadiumAttackBonus(s, atk, def)).toBe(0);
  });

  it("Maximum Belt adds +50 vs ex defenders", () => {
    const atk = mkInPlay(mkPokemon({ name: "Miraidon" }), {
      tools: [mkTool("Maximum Belt")],
    });
    const defEx = mkInPlay(mkPokemon({ name: "Charizard ex", subtypes: ["Basic", "ex"] }));
    const defBasic = mkInPlay(mkPokemon({ name: "Wobbuffet", subtypes: ["Basic"] }));
    expect(stadiumAttackBonus(mkState(), atk, defEx)).toBe(50);
    expect(stadiumAttackBonus(mkState(), atk, defBasic)).toBe(0);
  });

  it("Jamming Tower suppresses Maximum Belt", () => {
    const atk = mkInPlay(mkPokemon(), { tools: [mkTool("Maximum Belt")] });
    const defEx = mkInPlay(mkPokemon({ subtypes: ["Basic", "ex"] }));
    const s = mkState({ stadium: { card: mkStadium("Jamming Tower"), controller: "p2" } });
    expect(stadiumAttackBonus(s, atk, defEx)).toBe(0);
  });
});

describe("stadiumDamageReduction — defender-side reductions", () => {
  it("Full Metal Lab reduces 30 for Metal defenders", () => {
    const atk = mkInPlay(mkPokemon({ types: ["Fire"] }));
    const def = mkInPlay(mkPokemon({ types: ["Metal"] }));
    const s = mkState({ stadium: { card: mkStadium("Full Metal Lab"), controller: "p1" } });
    expect(stadiumDamageReduction(s, atk, def)).toBe(30);
  });

  it("Neutralization Zone fully prevents damage from ex/V to non-Rule-Box defenders", () => {
    const atkEx = mkInPlay(mkPokemon({ subtypes: ["Basic", "ex"] }));
    const def = mkInPlay(mkPokemon({ subtypes: ["Basic"] }));
    const s = mkState({ stadium: { card: mkStadium("Neutralization Zone"), controller: "p1" } });
    // 9999 sentinel = full prevention (caps damage to 0 in actions.ts).
    expect(stadiumDamageReduction(s, atkEx, def)).toBe(9999);
  });

  it("Neutralization Zone does nothing when the attacker is non-Rule-Box", () => {
    const atk = mkInPlay(mkPokemon({ subtypes: ["Basic"] }));
    const def = mkInPlay(mkPokemon({ subtypes: ["Basic"] }));
    const s = mkState({ stadium: { card: mkStadium("Neutralization Zone"), controller: "p1" } });
    expect(stadiumDamageReduction(s, atk, def)).toBe(0);
  });

  it("Neutralization Zone does nothing when the defender has a Rule Box", () => {
    const atkEx = mkInPlay(mkPokemon({ subtypes: ["Basic", "ex"] }));
    const defEx = mkInPlay(mkPokemon({ subtypes: ["Basic", "ex"] }));
    const s = mkState({ stadium: { card: mkStadium("Neutralization Zone"), controller: "p1" } });
    expect(stadiumDamageReduction(s, atkEx, defEx)).toBe(0);
  });

  it("Occa Berry reduces 60 vs Fire attacker", () => {
    const fireAtk = mkInPlay(mkPokemon({ types: ["Fire"] }));
    const def = mkInPlay(mkPokemon(), { tools: [mkTool("Occa Berry")] });
    expect(stadiumDamageReduction(mkState(), fireAtk, def)).toBe(60);
  });

  it("Occa Berry does NOT reduce damage from non-Fire attackers", () => {
    const waterAtk = mkInPlay(mkPokemon({ types: ["Water"] }));
    const def = mkInPlay(mkPokemon(), { tools: [mkTool("Occa Berry")] });
    expect(stadiumDamageReduction(mkState(), waterAtk, def)).toBe(0);
  });
});

describe("effectiveAttackCost — Tool cost reductions", () => {
  it("Counter Gain reduces -C when ahead on prizes", () => {
    const atk = mkInPlay(mkPokemon(), { tools: [mkTool("Counter Gain")] });
    const s = mkState();
    // Pretend we have MORE prizes remaining than opponent (i.e. we're behind in KOs).
    // Counter Gain's rule says: if you have MORE prizes remaining than opp, -C.
    s.players.p1.prizes = Array(5).fill(null) as any;
    s.players.p2.prizes = Array(3).fill(null) as any;
    s.players.p1.active = atk;
    expect(effectiveAttackCost(s, atk, ["Colorless", "Colorless"])).toEqual(["Colorless"]);
  });

  it("Counter Gain does nothing when ahead on KOs", () => {
    const atk = mkInPlay(mkPokemon(), { tools: [mkTool("Counter Gain")] });
    const s = mkState();
    s.players.p1.prizes = Array(3).fill(null) as any;
    s.players.p2.prizes = Array(5).fill(null) as any;
    s.players.p1.active = atk;
    expect(effectiveAttackCost(s, atk, ["Colorless", "Colorless"])).toEqual(["Colorless", "Colorless"]);
  });

  it("Sparkling Crystal reduces 1 Energy for Tera Pokémon", () => {
    const atk = mkInPlay(mkPokemon({ subtypes: ["Basic", "Tera"] }), {
      tools: [mkTool("Sparkling Crystal")],
    });
    const s = mkState();
    s.players.p1.active = atk;
    expect(effectiveAttackCost(s, atk, ["Colorless", "Colorless"])).toEqual(["Colorless"]);
  });

  it("Nighttime Mine adds +C to Tera attacks", () => {
    const atk = mkInPlay(mkPokemon({ subtypes: ["Basic", "Tera"] }));
    const s = mkState({ stadium: { card: mkStadium("Nighttime Mine"), controller: "p2" } });
    expect(effectiveAttackCost(s, atk, ["Colorless"])).toEqual(["Colorless", "Colorless"]);
  });
});

describe("prizeReductionFromTools — Lillie's Pearl", () => {
  it("no reduction when not Lillie's Pokémon", () => {
    const p = mkInPlay(mkPokemon({ name: "Charizard ex" }), {
      tools: [mkTool("Lillie's Pearl")],
    });
    expect(prizeReductionFromTools(p)).toBe(0);
  });

  it("reduces 1 prize for Lillie's Pokémon", () => {
    const p = mkInPlay(mkPokemon({ name: "Lillie's Clefairy ex" }), {
      tools: [mkTool("Lillie's Pearl")],
    });
    expect(prizeReductionFromTools(p)).toBe(1);
  });
});

describe("passiveAttackBonus — Pokémon-ability buffs", () => {
  function mkAbility(name: string, text: string) {
    return { name, type: "Ability", text };
  }

  it("Garganacl Powerful a-Salt adds +30 to Fighting attackers", () => {
    const s = mkState();
    // Holder: Garganacl on bench.
    const garganacl = mkInPlay(
      mkPokemon({
        name: "Garganacl",
        abilities: [mkAbility("Powerful a-Salt", "Attacks used by your Fighting Pokémon do 30 more damage to your opponent's Active Pokémon (before applying Weakness and Resistance).") as any],
      }),
    );
    // Attacker: Fighting-type.
    const atk = mkInPlay(mkPokemon({ name: "Koraidon ex", types: ["Fighting"] }));
    s.players.p1.active = atk;
    s.players.p1.bench = [garganacl];
    expect(passiveAttackBonus(s, "p1", atk, null)).toBe(30);
  });

  it("Non-Fighting attacker gets no Garganacl buff", () => {
    const s = mkState();
    const garganacl = mkInPlay(
      mkPokemon({
        name: "Garganacl",
        abilities: [mkAbility("Powerful a-Salt", "Attacks used by your Fighting Pokémon do 30 more damage to your opponent's Active Pokémon (before applying Weakness and Resistance).") as any],
      }),
    );
    const atk = mkInPlay(mkPokemon({ types: ["Fire"] }));
    s.players.p1.active = atk;
    s.players.p1.bench = [garganacl];
    expect(passiveAttackBonus(s, "p1", atk, null)).toBe(0);
  });

  it("Serperior ex Regal Cheer adds +20 to all your Pokémon's attacks", () => {
    const s = mkState();
    const serperior = mkInPlay(
      mkPokemon({
        name: "Serperior ex",
        abilities: [mkAbility("Regal Cheer", "Attacks used by your Pokémon do 20 more damage to your opponent's Active Pokémon (before applying Weakness and Resistance).") as any],
      }),
    );
    const atk = mkInPlay(mkPokemon({ types: ["Water"] }));
    s.players.p1.active = atk;
    s.players.p1.bench = [serperior];
    expect(passiveAttackBonus(s, "p1", atk, null)).toBe(20);
  });

  it("Multiple passive abilities STACK", () => {
    const s = mkState();
    const serperior = mkInPlay(
      mkPokemon({
        name: "Serperior ex",
        abilities: [mkAbility("Regal Cheer", "...") as any],
      }),
    );
    const lilligant = mkInPlay(
      mkPokemon({
        name: "Lilligant",
        abilities: [mkAbility("Sunny Day", "...") as any],
      }),
    );
    const atk = mkInPlay(mkPokemon({ types: ["Grass"] }));
    s.players.p1.active = atk;
    s.players.p1.bench = [serperior, lilligant];
    // Regal Cheer +20, Sunny Day +20 for Grass — total +40.
    expect(passiveAttackBonus(s, "p1", atk, null)).toBe(40);
  });
});

describe("applySurvivalBrace — full-HP survival", () => {
  it("full HP + brace + lethal damage → capped so 10 HP remain", () => {
    const p = mkInPlay(mkPokemon({ hp: 100 }), { tools: [mkTool("Survival Brace")] });
    const capped = applySurvivalBrace(mkState(), p, 150);
    expect(capped).toBe(90); // leaves 10 HP
  });

  it("brace does not trigger when already damaged", () => {
    const p = mkInPlay(mkPokemon({ hp: 100 }), {
      damage: 30,
      tools: [mkTool("Survival Brace")],
    });
    const capped = applySurvivalBrace(mkState(), p, 150);
    expect(capped).toBe(150); // no cap
  });

  it("brace does not trigger on non-lethal damage", () => {
    const p = mkInPlay(mkPokemon({ hp: 100 }), { tools: [mkTool("Survival Brace")] });
    const capped = applySurvivalBrace(mkState(), p, 50);
    expect(capped).toBe(50); // no cap, wasn't lethal
  });

  it("Jamming Tower disables brace", () => {
    const p = mkInPlay(mkPokemon({ hp: 100 }), { tools: [mkTool("Survival Brace")] });
    const s = mkState({ stadium: { card: mkStadium("Jamming Tower"), controller: "p2" } });
    const capped = applySurvivalBrace(s, p, 150);
    expect(capped).toBe(150);
  });
});

describe("estimateAttackDamage — effective Weakness rewrites", () => {
  it("uses Fairy Zone's Psychic Weakness override for Dragon defenders", () => {
    const s = mkState();
    const attacker = mkInPlay(
      mkPokemon({
        name: "Psychic Attacker",
        types: ["Psychic"],
        attacks: [{ name: "Mind Hit", cost: [], damage: 50 }],
      }),
    );
    const defender = mkInPlay(
      mkPokemon({
        name: "Dragon Defender",
        types: ["Dragon"],
        weaknesses: [{ type: "Lightning", value: "×2" }],
      }),
    );
    const fairyZoneHolder = mkInPlay(
      mkPokemon({
        name: "Fairy Zone Holder",
        abilities: [{ name: "Fairy Zone", type: "Ability", text: "Dragon Weakness becomes Psychic." } as any],
      }),
    );
    s.players.p1.active = attacker;
    s.players.p2.active = defender;
    s.players.p1.bench = [fairyZoneHolder];

    expect(estimateAttackDamage(s, "p1", attacker, attacker.card.attacks[0])).toBe(100);
  });

  it("uses ability-added attacker types for Weakness checks", () => {
    const s = mkState();
    const attacker = mkInPlay(
      mkPokemon({
        name: "Double Type Attacker",
        types: ["Psychic"],
        abilities: [{ name: "Double Type", type: "Ability", text: "This Pokémon is Psychic and Fighting." } as any],
        attacks: [{ name: "Type Hit", cost: [], damage: 50 }],
      }),
    );
    const defender = mkInPlay(
      mkPokemon({
        name: "Fighting Weak Defender",
        types: ["Colorless"],
        weaknesses: [{ type: "Fighting", value: "×2" }],
      }),
    );
    s.players.p1.active = attacker;
    s.players.p2.active = defender;

    expect(estimateAttackDamage(s, "p1", attacker, attacker.card.attacks[0])).toBe(100);
  });
});
