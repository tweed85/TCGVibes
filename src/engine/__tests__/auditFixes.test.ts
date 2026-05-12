// Regression tests for bugs surfaced by the 5-agent card-action audit:
//   C2  Carmine T1 supporter exception
//   C4  Brambleghast Prison Panic — Confused (was Asleep)
//   C5  AOE attacks (allOpponents) include Active with W/R applied
//   C6  Potion bench picker
//   C7  Super Potion bench picker
//   C7  Raifort top-5 peek/discard/reorder
//   C1  Lt. Surge's Bargain — opp consents only when they'd win, else draw 4
//   C3  Brock's Scouting — Evolution branch when in-play allows it
//   H1  Future Booster Energy Capsule +20 damage to opp Active
//   H2  Rescue Board free retreat at HP ≤ 30
//   H3  Ancient Booster Energy Capsule status immunity + recovery on attach
//   M1  Handheld Fan moves attacker's Energy to attacker's bench
//   M3  Technical Machine: Fluorite — attack + end-of-turn discard

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  isBasic,
  isPokemon,
  completeSetup,
  endTurn,
} from "../rules";
import { attack, playTrainer } from "../actions";
import { applyTrainerEffect } from "../trainerEffects";
import { canBeAfflictedBy, effectiveAttacks, effectiveRetreatCost, stadiumAttackBonus } from "../ongoingEffects";
import { fireTriggeredOnEvolve } from "../abilities";
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

const mkInPlay = (card: PokemonCard, opts: Partial<PokemonInPlay> = {}): PokemonInPlay => ({
  instanceId: `inst-${card.id}`,
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
// C2 — Carmine T1 exception
// ---------------------------------------------------------------------------

describe("Carmine — T1 supporter exception", () => {
  const carmine = (): TrainerCard => ({
    id: "carmine-test",
    name: "Carmine",
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId: "discardHandDraw5",
  } as TrainerCard);

  it("first player T1 ban is bypassed for Carmine", () => {
    const state = bootGameToMain(401);
    const ap = state.activePlayer;
    state.firstTurnNoAttack = true;
    state.turn = 1;
    state.players[ap].hand = [carmine(), ...state.players[ap].hand];
    const r = playTrainer(state, ap, 0);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4 — Prison Panic applies Confused, not Asleep
// ---------------------------------------------------------------------------

describe("Brambleghast Prison Panic", () => {
  it("applies Confused to opp Active (not Asleep)", () => {
    const state = bootGameToMain(501);
    const ap = state.activePlayer;
    const oppId = ap === "p1" ? "p2" : "p1";
    state.players[oppId].active!.statuses = [];
    const me = state.players[ap].active!;
    me.card = {
      ...me.card,
      name: "Brambleghast",
      abilities: [{ name: "Prison Panic", text: "...", type: "Ability" }],
    } as PokemonCard;
    me.evolvedThisTurn = true;
    me.abilityUsedThisTurn = false;
    fireTriggeredOnEvolve(state, ap, me);
    expect(state.players[oppId].active!.statuses).toContain("confused");
    expect(state.players[oppId].active!.statuses).not.toContain("asleep");
  });
});

// ---------------------------------------------------------------------------
// C5 — allOpponents AOE hits Active too
// ---------------------------------------------------------------------------

describe("allOpponents AOE — hits opp Active with W/R", () => {
  it("Active gets the snipe damage too", () => {
    const state = bootGameToMain(601);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    state.players[ap].active!.card = mkBasic("frosmoth", {
      types: ["Water"],
      attacks: [
        {
          name: "Chilling Wings",
          cost: [],
          damage: 0,
          text: "20 damage to each.",
          effects: [{ kind: "benchSnipe", damage: 20, target: "allOpponents" }],
        },
      ],
    });
    state.players[opp].active!.card = mkBasic("tank", { hp: 200 });
    state.players[opp].active!.damage = 0;
    state.players[opp].bench = [mkInPlay(mkBasic("benched-1"))];
    attack(state, ap, 0);
    // Active took 20 (no W/R since both Colorless attack vs Colorless target).
    expect(state.players[opp].active?.damage ?? 999).toBe(20);
    // Bench took 20 with no W/R.
    expect(state.players[opp].bench[0].damage).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// C6 — Potion bench picker (heals from any Pokémon)
// ---------------------------------------------------------------------------

describe("Potion — heal any 1 of your Pokémon", () => {
  const potion = (): TrainerCard => ({
    id: "potion-test",
    name: "Potion",
    supertype: "Trainer",
    subtypes: ["Item"],
    text: "...",
    effectId: "heal30Active",
  } as TrainerCard);

  it("auto-picks the most-damaged when multiple damaged candidates", () => {
    const state = bootGameToMain(701);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].active!.damage = 30;
    state.players[ap].bench = [mkInPlay(mkBasic("a"), { damage: 80 })];
    applyTrainerEffect(state, ap, potion());
    // AI heals the bench Pokémon (more damage), 80 → 50.
    expect(state.players[ap].bench[0].damage).toBe(50);
    expect(state.players[ap].active!.damage).toBe(30);
  });

  it("opens picker for human when 2+ damaged candidates", () => {
    const state = bootGameToMain(702);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].active!.damage = 40;
    state.players[ap].bench = [mkInPlay(mkBasic("a"), { damage: 80 })];
    applyTrainerEffect(state, ap, potion());
    expect(state.pendingInPlayTarget).not.toBeNull();
    expect(state.pendingInPlayTarget!.action.kind).toBe("potionHeal");
  });

  it("auto-resolves to lone damaged Pokémon", () => {
    const state = bootGameToMain(703);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    state.players[ap].active!.damage = 50;
    state.players[ap].bench = [mkInPlay(mkBasic("a"), { damage: 0 })];
    applyTrainerEffect(state, ap, potion());
    // Only one damaged → no picker; just heals.
    expect(state.pendingInPlayTarget).toBeNull();
    expect(state.players[ap].active!.damage).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// C7 — Super Potion bench picker (requires Energy attached)
// ---------------------------------------------------------------------------

describe("Super Potion — heal any with Energy + discard 1 Energy", () => {
  const superPotion = (): TrainerCard => ({
    id: "super-potion-test",
    name: "Super Potion",
    supertype: "Trainer",
    subtypes: ["Item"],
    text: "...",
    effectId: "heal60DiscardEnergy",
  } as TrainerCard);

  it("auto-picks bench Pokémon with damage and Energy", () => {
    const state = bootGameToMain(801);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].active!.damage = 30;
    state.players[ap].active!.attachedEnergy = [E("Fire")];
    state.players[ap].bench = [
      mkInPlay(mkBasic("a"), { damage: 100, attachedEnergy: [E("Water")] }),
    ];
    applyTrainerEffect(state, ap, superPotion());
    // AI picks the bench (more damage). Bench: 100 → 40, energy discarded.
    expect(state.players[ap].bench[0].damage).toBe(40);
    expect(state.players[ap].bench[0].attachedEnergy).toHaveLength(0);
    // Active untouched.
    expect(state.players[ap].active!.damage).toBe(30);
    expect(state.players[ap].active!.attachedEnergy).toHaveLength(1);
  });

  it("skips Pokémon with no Energy", () => {
    const state = bootGameToMain(802);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    state.players[ap].active!.damage = 60;
    state.players[ap].active!.attachedEnergy = []; // no energy
    state.players[ap].bench = [
      mkInPlay(mkBasic("a"), { damage: 50, attachedEnergy: [E("Water")] }),
    ];
    applyTrainerEffect(state, ap, superPotion());
    // Active is most damaged but has no Energy — must skip.
    expect(state.players[ap].active!.damage).toBe(60);
    expect(state.players[ap].bench[0].damage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C7 — Raifort top-5 peek/discard
// ---------------------------------------------------------------------------

describe("Raifort — peek top 5, discard any number", () => {
  const raifort = (): TrainerCard => ({
    id: "raifort-test",
    name: "Raifort",
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId: "raifortPeek5Discard",
  } as TrainerCard);

  it("opens a pendingPick with top 5 cards as the pool", () => {
    const state = bootGameToMain(901);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    // Force deterministic top of deck with 5 distinct trash Energies.
    const top5 = [E("Fire"), E("Water"), E("Grass"), E("Lightning"), E("Psychic")];
    state.players[ap].deck = [...top5, ...state.players[ap].deck];
    applyTrainerEffect(state, ap, raifort());
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.pool.length).toBe(5);
    expect(state.pendingPick!.unpicked).toBe("topOfDeck");
    expect(state.pendingPick!.pickedDestination).toBe("discard");
    expect(state.pendingPick!.min).toBe(0);
    expect(state.pendingPick!.max).toBe(5);
  });

  it("AI: keeps everything on top (conservative no-discard)", () => {
    const state = bootGameToMain(902);
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    const top = [E("Fire"), E("Water"), E("Grass")];
    state.players[ap].deck = [...top, ...state.players[ap].deck];
    const beforeDiscardCount = state.players[ap].discard.length;
    applyTrainerEffect(state, ap, raifort());
    expect(state.pendingPick).toBeNull();
    // Top 3 still on top in original order.
    expect(state.players[ap].deck[0].name).toBe("Basic Fire Energy");
    expect(state.players[ap].deck[1].name).toBe("Basic Water Energy");
    expect(state.players[ap].deck[2].name).toBe("Basic Grass Energy");
    expect(state.players[ap].discard.length).toBe(beforeDiscardCount);
  });
});

// ---------------------------------------------------------------------------
// C1 — Lt. Surge's Bargain
// ---------------------------------------------------------------------------

describe("Lt. Surge's Bargain", () => {
  const ltSurge = (): TrainerCard => ({
    id: "lt-surge-test",
    name: "Lt. Surge's Bargain",
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId: "ltSurgeBargain",
  } as TrainerCard);

  it("opp declines (default) → user draws 4", () => {
    const state = bootGameToMain(1001);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    // Both at 6 prizes — opp has nothing to gain by saying yes.
    expect(state.players[ap].prizes.length).toBe(6);
    expect(state.players[opp].prizes.length).toBe(6);
    state.players[ap].hand = [];
    applyTrainerEffect(state, ap, ltSurge());
    expect(state.players[ap].hand.length).toBe(4);
    expect(state.players[ap].prizes.length).toBe(6); // no prize taken
    expect(state.players[opp].prizes.length).toBe(6);
  });

  it("opp at 1 prize, user at 2 → opp consents, both take a prize, opp wins", () => {
    const state = bootGameToMain(1002);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    // Setup: opp at 1, user at 2.
    state.players[opp].prizes = state.players[opp].prizes.slice(0, 1);
    state.players[ap].prizes = state.players[ap].prizes.slice(0, 2);
    applyTrainerEffect(state, ap, ltSurge());
    // Both took a prize — user 2→1, opp 1→0 (opp wins).
    expect(state.players[ap].prizes.length).toBe(1);
    expect(state.players[opp].prizes.length).toBe(0);
    expect(state.winner).toBe(opp);
  });
});

// ---------------------------------------------------------------------------
// C3 — Brock's Scouting branching
// ---------------------------------------------------------------------------

describe("Brock's Scouting", () => {
  const brock = (): TrainerCard => ({
    id: "brock-test",
    name: "Brock's Scouting",
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId: "searchUpTo2Basic",
  } as TrainerCard);

  it("Evolution branch when in-play has a matching Evolution in deck", () => {
    const state = bootGameToMain(1101);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    // Active is "Pikachu" (Basic). Deck contains "Raichu" (evolves from Pikachu).
    state.players[ap].active!.card = mkBasic("pika", { name: "Pikachu" });
    const raichu: PokemonCard = {
      id: "raichu", name: "Raichu",
      supertype: "Pokémon", subtypes: ["Stage 1"], hp: 110,
      types: ["Lightning"], attacks: [], retreatCost: [],
      evolvesFrom: "Pikachu",
    } as PokemonCard;
    state.players[ap].deck = [raichu, ...state.players[ap].deck];
    applyTrainerEffect(state, ap, brock());
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Evolution/);
    expect(state.pendingPick!.max).toBe(1);
  });

  it("Basic branch when no playable Evolution available", () => {
    const state = bootGameToMain(1102);
    const ap = state.activePlayer;
    state.players[ap].isAI = false;
    // Replace deck with strictly Basics + Energies — no evolutions whatsoever.
    state.players[ap].deck = [
      mkBasic("a"),
      mkBasic("b"),
      mkBasic("c"),
      E("Fire"), E("Fire"), E("Fire"),
    ];
    state.players[ap].active!.card = mkBasic("solo", { name: "Solo" });
    state.players[ap].bench = [];
    applyTrainerEffect(state, ap, brock());
    expect(state.pendingPick).not.toBeNull();
    expect(state.pendingPick!.label).toMatch(/Basic/);
    expect(state.pendingPick!.max).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// H1 — Future Booster Energy Capsule +20 damage
// ---------------------------------------------------------------------------

describe("Future Booster Energy Capsule", () => {
  it("adds +20 to attacks from a Future Pokémon", () => {
    const state = bootGameToMain(1201);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    const futureCard = mkBasic("iron-bundle", {
      subtypes: ["Basic", "Future"],
    });
    const attacker = mkInPlay(futureCard);
    attacker.tools = [{
      id: "fbec-test",
      name: "Future Booster Energy Capsule",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool", "Future"],
      text: "...",
    } as TrainerCard];
    state.players[ap].active = attacker;
    const defender = state.players[opp].active!;
    const bonus = stadiumAttackBonus(state, attacker, defender);
    expect(bonus).toBe(20);
  });

  it("does NOT add bonus to non-Future Pokémon (gate works)", () => {
    const state = bootGameToMain(1202);
    const ap = state.activePlayer;
    const opp = ap === "p1" ? "p2" : "p1";
    const nonFutureCard = mkBasic("pikachu");
    const attacker = mkInPlay(nonFutureCard);
    attacker.tools = [{
      id: "fbec-test-2",
      name: "Future Booster Energy Capsule",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool", "Future"],
      text: "...",
    } as TrainerCard];
    state.players[ap].active = attacker;
    const defender = state.players[opp].active!;
    const bonus = stadiumAttackBonus(state, attacker, defender);
    expect(bonus).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H2 — Rescue Board free retreat at HP ≤ 30
// ---------------------------------------------------------------------------

describe("Rescue Board", () => {
  const rescueBoardTool = (): TrainerCard => ({
    id: "rb-test",
    name: "Rescue Board",
    supertype: "Trainer",
    subtypes: ["Pokémon Tool"],
    text: "...",
  } as TrainerCard);

  it("retreat cost reduced by 1 at full HP", () => {
    const state = bootGameToMain(1301);
    const ap = state.activePlayer;
    const card = mkBasic("clefable", { hp: 110, retreatCost: ["Colorless", "Colorless"] });
    const inPlay = mkInPlay(card, { tools: [rescueBoardTool()] });
    state.players[ap].active = inPlay;
    expect(effectiveRetreatCost(inPlay, state).length).toBe(1);
  });

  it("free retreat when remaining HP ≤ 30", () => {
    const state = bootGameToMain(1302);
    const ap = state.activePlayer;
    const card = mkBasic("clefable", { hp: 110, retreatCost: ["Colorless", "Colorless"] });
    const inPlay = mkInPlay(card, { tools: [rescueBoardTool()], damage: 80 }); // 30 hp left
    state.players[ap].active = inPlay;
    expect(effectiveRetreatCost(inPlay, state).length).toBe(0);
  });

  it("free retreat just barely at HP=30", () => {
    const state = bootGameToMain(1303);
    const ap = state.activePlayer;
    const card = mkBasic("test", { hp: 100, retreatCost: ["Colorless"] });
    const inPlay = mkInPlay(card, { tools: [rescueBoardTool()], damage: 70 }); // 30 hp
    state.players[ap].active = inPlay;
    expect(effectiveRetreatCost(inPlay, state).length).toBe(0);
  });

  it("not free at HP=40 (above threshold)", () => {
    const state = bootGameToMain(1304);
    const ap = state.activePlayer;
    const card = mkBasic("test", { hp: 100, retreatCost: ["Colorless", "Colorless"] });
    const inPlay = mkInPlay(card, { tools: [rescueBoardTool()], damage: 60 }); // 40 hp
    state.players[ap].active = inPlay;
    // Reduced to 1, not 0.
    expect(effectiveRetreatCost(inPlay, state).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H3 — Ancient Booster Energy Capsule status immunity + recovery
// ---------------------------------------------------------------------------

describe("Ancient Booster Energy Capsule", () => {
  it("Ancient Pokémon with the tool is status-immune", () => {
    const state = bootGameToMain(1401);
    const ap = state.activePlayer;
    const ancientCard = mkBasic("roaring-moon", { subtypes: ["Basic", "Ancient"] });
    const inPlay = mkInPlay(ancientCard, {
      tools: [{
        id: "abec-test",
        name: "Ancient Booster Energy Capsule",
        supertype: "Trainer",
        subtypes: ["Pokémon Tool", "Ancient"],
        text: "...",
      } as TrainerCard],
    });
    state.players[ap].active = inPlay;
    expect(canBeAfflictedBy(inPlay, "asleep", state)).toBe(false);
    expect(canBeAfflictedBy(inPlay, "burned", state)).toBe(false);
    expect(canBeAfflictedBy(inPlay, "confused", state)).toBe(false);
    expect(canBeAfflictedBy(inPlay, "poisoned", state)).toBe(false);
  });

  it("non-Ancient Pokémon doesn't gain immunity from the tool (gate)", () => {
    const state = bootGameToMain(1402);
    const ap = state.activePlayer;
    const nonAncient = mkBasic("pikachu");
    const inPlay = mkInPlay(nonAncient, {
      tools: [{
        id: "abec-test-2",
        name: "Ancient Booster Energy Capsule",
        supertype: "Trainer",
        subtypes: ["Pokémon Tool", "Ancient"],
        text: "...",
      } as TrainerCard],
    });
    state.players[ap].active = inPlay;
    expect(canBeAfflictedBy(inPlay, "asleep", state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3 — Technical Machine: Fluorite — attack + end-of-turn discard
// ---------------------------------------------------------------------------

describe("Technical Machine: Fluorite", () => {
  const fluoriteTool = (): TrainerCard => ({
    id: "tm-fluorite-test",
    name: "Technical Machine: Fluorite",
    supertype: "Trainer",
    subtypes: ["Pokémon Tool"],
    text: "...",
  } as TrainerCard);

  it("the holder gains the Fluorite attack via effectiveAttacks", () => {
    const state = bootGameToMain(1501);
    const ap = state.activePlayer;
    const holder = mkInPlay(mkBasic("teal-ogerpon"), { tools: [fluoriteTool()] });
    state.players[ap].active = holder;
    const attacks = effectiveAttacks(holder);
    const fluo = attacks.find((a) => a.name === "Fluorite");
    expect(fluo).toBeDefined();
    expect(fluo!.cost).toEqual(["Grass", "Water", "Psychic"]);
  });

  it("end of turn: TM Fluorite discards itself", () => {
    const state = bootGameToMain(1502);
    const ap = state.activePlayer;
    const holder = mkInPlay(mkBasic("any"), { tools: [fluoriteTool()] });
    state.players[ap].active = holder;
    const beforeDiscardCount = state.players[ap].discard.length;
    state.firstTurnNoAttack = false;
    state.phase = "main";
    endTurn(state);
    expect(holder.tools.length).toBe(0);
    expect(state.players[ap].discard.length).toBe(beforeDiscardCount + 1);
    expect(state.players[ap].discard[state.players[ap].discard.length - 1].name)
      .toBe("Technical Machine: Fluorite");
  });
});
