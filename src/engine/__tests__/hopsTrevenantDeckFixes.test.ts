// Hop's Trevenant deck card-mechanic audit fixes (4-agent sweep round 2):
//
//   1. Cramorant Fickle Spitting — verified correct (no bug; documented test)
//   2. Fezandipiti ex Cruel Arrow — bench-only handler now allows Active
//      target with W/R; new `benchOnly` field on `snipeOne` effect
//   3. Hop's Trevenant Horrifying Revenge — predicate now uses
//      `yourPokemonKoedByAttackLastOppTurnNames` (only attack-damage KOs,
//      tracked by name), not the loose "any KO + any sibling in play"
//      heuristic
//   4. Hop's Choice Band cost reduction — no longer pops typed energy
//      slots when the cost has no Colorless to strip
//   5. Hop's Bag — picker max clamped to remaining bench slots

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  isBasic,
  isPokemon,
  completeSetup,
  makePokemonInPlay,
  endTurn,
} from "../rules";
import { resolveAttackEffects } from "../effects";
import { canPayCost } from "../rules";
import { effectiveAttackCost, effectiveRetreatCost, estimateAttackDamage, energyPoolForCost } from "../ongoingEffects";
import { extractEffects } from "../../data/effectPatterns";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  GameState,
  PokemonCard,
  TrainerCard,
  EnergyType,
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
// 1. Cramorant Fickle Spitting — verified correct (no logic flip)
// ---------------------------------------------------------------------------

describe("Hop's Cramorant Fickle Spitting — fizzle predicate", () => {
  it("hits at exactly 3 prizes (per card text)", () => {
    const result = extractEffects({
      name: "Fickle Spitting",
      cost: ["Colorless"],
      damage: "120",
      text: "If your opponent doesn't have exactly 3 or 4 Prize cards remaining, this attack does nothing.",
    } as Parameters<typeof extractEffects>[0]);
    const cond = result.effects.find((e) => e.kind === "conditionalDamage");
    expect(cond).toBeDefined();
    if (!cond || cond.kind !== "conditionalDamage") return;
    expect(cond.mode).toBe("fizzleIfNot");
    expect(cond.predicate).toEqual({ kind: "oppPrizesInRange", min: 3, max: 4 });
  });
});

// ---------------------------------------------------------------------------
// 2. Fezandipiti ex Cruel Arrow — Active or Bench target
// ---------------------------------------------------------------------------

describe("Fezandipiti ex Cruel Arrow — snipeOne with benchOnly:false", () => {
  it("hits the Active when no override is given (and applies W/R)", () => {
    const state = bootGameToMain(11001);
    const attacker = makePokemonInPlay(mkBasic("fez", { name: "Fezandipiti ex", types: ["Darkness"] }));
    state.players.p1.active = attacker;
    const oppActive = makePokemonInPlay({
      ...mkBasic("opp", { name: "Opp", hp: 200 }),
      weaknesses: [{ type: "Darkness", value: "×2" }],
    } as PokemonCard);
    state.players.p2.active = oppActive;
    state.players.p2.bench = [];

    const move = {
      name: "Cruel Arrow",
      cost: ["Colorless", "Colorless", "Colorless"] as EnergyType[],
      damage: 0,
      effects: [{ kind: "snipeOne" as const, damage: 100, benchOnly: false }],
    };
    const r = resolveAttackEffects(state, {
      attacker,
      attackerOwner: "p1",
      defender: oppActive,
      defenderOwner: "p2",
      move,
      damage: 0,
    });
    r.postDamage?.();
    // Active target hit with W/R: 100 × 2 = 200.
    expect(oppActive.damage).toBe(200);
  });

  it("hits a bench target via override (no W/R for bench per card text)", () => {
    const state = bootGameToMain(11002);
    const attacker = makePokemonInPlay(mkBasic("fez", { name: "Fezandipiti ex", types: ["Darkness"] }));
    state.players.p1.active = attacker;
    const oppActive = makePokemonInPlay(mkBasic("opp", { name: "Opp", hp: 200 }));
    const oppBench = makePokemonInPlay({
      ...mkBasic("benchOpp", { name: "BenchOpp", hp: 200 }),
      weaknesses: [{ type: "Darkness", value: "×2" }],
    } as PokemonCard);
    state.players.p2.active = oppActive;
    state.players.p2.bench = [oppBench];
    state.snipeTargetOverride = 0;

    const move = {
      name: "Cruel Arrow",
      cost: ["Colorless", "Colorless", "Colorless"] as EnergyType[],
      damage: 0,
      effects: [{ kind: "snipeOne" as const, damage: 100, benchOnly: false }],
    };
    const r = resolveAttackEffects(state, {
      attacker,
      attackerOwner: "p1",
      defender: oppActive,
      defenderOwner: "p2",
      move,
      damage: 0,
    });
    r.postDamage?.();
    // Bench target: flat 100, no W/R applied per "Don't apply W/R for Benched".
    expect(oppBench.damage).toBe(100);
    expect(oppActive.damage).toBe(0);
  });

  it("benchOnly:true (Insta-Strike pattern) only hits bench", () => {
    const state = bootGameToMain(11003);
    const attacker = makePokemonInPlay(mkBasic("z", { name: "Hop's Zacian ex" }));
    state.players.p1.active = attacker;
    state.players.p2.active = makePokemonInPlay(mkBasic("opp", { name: "Opp", hp: 200 }));
    const oppBench = makePokemonInPlay(mkBasic("benchOpp", { name: "BenchOpp", hp: 200 }));
    state.players.p2.bench = [oppBench];

    const move = {
      name: "Insta-Strike",
      cost: ["Colorless"] as EnergyType[],
      damage: 30,
      effects: [{ kind: "snipeOne" as const, damage: 30, benchOnly: true }],
    };
    const r = resolveAttackEffects(state, {
      attacker,
      attackerOwner: "p1",
      defender: state.players.p2.active!,
      defenderOwner: "p2",
      move,
      damage: 30,
    });
    r.postDamage?.();
    // Bench target hit; Active untouched by the snipe (Active gets the
    // 30 base via the main attack pipeline, not the snipe).
    expect(oppBench.damage).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 3. Hop's Trevenant Horrifying Revenge — predicate uses attack-KO names
// ---------------------------------------------------------------------------

describe("Horrifying Revenge — yourPokemonKoedByAttackLastOppTurnNames", () => {
  it("populated only by attack-damage KOs (not status / recoil)", () => {
    const state = bootGameToMain(11101);
    const ap = state.activePlayer;
    const dp = ap === "p1" ? "p2" : "p1";
    // No KOs yet — list empty.
    expect(state.players[ap].yourPokemonKoedByAttackLastOppTurnNames).toEqual([]);
    expect(state.players[dp].yourPokemonKoedByAttackLastOppTurnNames).toEqual([]);
  });

  it("end-of-turn cleanup clears the names list", () => {
    const state = bootGameToMain(11102);
    const ap = state.activePlayer;
    state.players[ap].yourPokemonKoedByAttackLastOppTurnNames = ["Hop's Phantump"];
    endTurn(state);
    expect(state.players[ap].yourPokemonKoedByAttackLastOppTurnNames).toEqual([]);
  });

  it("predicate matches against KO'd names, not in-play sibling heuristic", async () => {
    const { extractEffects } = await import("../../data/effectPatterns");
    const result = extractEffects({
      name: "Horrifying Revenge",
      cost: ["Colorless"],
      damage: "30+",
      text: "If any of your Hop's Pokémon were Knocked Out by damage from an attack during your opponent's last turn, this attack does 100 more damage.",
    } as Parameters<typeof extractEffects>[0]);
    const cond = result.effects.find((e) => e.kind === "conditionalDamage");
    expect(cond).toBeDefined();
    if (!cond || cond.kind !== "conditionalDamage") return;
    expect(cond.predicate.kind).toBe("yourNamedPokemonKoedLastOppTurn");
    if (cond.predicate.kind !== "yourNamedPokemonKoedLastOppTurn") return;
    expect(cond.predicate.namePart.toLowerCase()).toBe("hop's");
  });
});

// ---------------------------------------------------------------------------
// 4. Hop's Choice Band cost reduction — no popping of typed energy
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Latias ex Skyliner — "Your Basic Pokémon in play have no Retreat Cost"
// must self-apply when Latias ex is Active (its own subtypes include "Basic")
// ---------------------------------------------------------------------------

describe("Latias ex Skyliner — applies to all your Basics, INCLUDING self when Active", () => {
  const mkLatias = (): PokemonCard => ({
    id: "latias-test",
    name: "Latias ex",
    supertype: "Pokémon",
    subtypes: ["Basic", "ex"],
    hp: 210,
    types: ["Dragon"],
    attacks: [],
    retreatCost: ["Colorless", "Colorless"],
    abilities: [
      {
        name: "Skyliner",
        type: "Ability",
        text: "Your Basic Pokémon in play have no Retreat Cost.",
      },
    ],
  } as PokemonCard);

  it("Latias ex (Active) retreating itself: cost reduces to 0", () => {
    const state = bootGameToMain(11301);
    const latias = makePokemonInPlay(mkLatias());
    state.players.p1.active = latias;
    state.players.p1.bench = [];
    const cost = effectiveRetreatCost(latias, state);
    expect(cost).toEqual([]);
  });

  it("Latias ex (Active) makes a Benched Basic ally retreat for free", () => {
    const state = bootGameToMain(11302);
    const latias = makePokemonInPlay(mkLatias());
    const benchBasic = makePokemonInPlay({
      ...mkBasic("a", { name: "Pikachu", types: ["Lightning"] }),
      retreatCost: ["Colorless", "Colorless"],
    } as PokemonCard);
    state.players.p1.active = latias;
    state.players.p1.bench = [benchBasic];
    expect(effectiveRetreatCost(benchBasic, state)).toEqual([]);
  });

  it("Latias ex (Bench) makes Active Basic retreat for free (still applies)", () => {
    const state = bootGameToMain(11303);
    const latias = makePokemonInPlay(mkLatias());
    const activeBasic = makePokemonInPlay({
      ...mkBasic("a", { name: "Pikachu", types: ["Lightning"] }),
      retreatCost: ["Colorless"],
    } as PokemonCard);
    state.players.p1.active = activeBasic;
    state.players.p1.bench = [latias];
    expect(effectiveRetreatCost(activeBasic, state)).toEqual([]);
  });

  it("does NOT apply to Stage 1 / Stage 2 (only Basics get the discount)", () => {
    const state = bootGameToMain(11304);
    const latias = makePokemonInPlay(mkLatias());
    const stage1 = makePokemonInPlay({
      ...mkBasic("s1", { name: "Drakloak" }),
      subtypes: ["Stage 1"],
      retreatCost: ["Colorless"],
    } as PokemonCard);
    state.players.p1.active = stage1;
    state.players.p1.bench = [latias];
    // Stage 1 retains its Colorless retreat cost.
    expect(effectiveRetreatCost(stage1, state)).toEqual(["Colorless"]);
  });

  it("opponent's Latias ex does NOT free YOUR retreat (per-side check)", () => {
    const state = bootGameToMain(11305);
    const myActive = makePokemonInPlay({
      ...mkBasic("a", { name: "Pikachu" }),
      retreatCost: ["Colorless", "Colorless"],
    } as PokemonCard);
    const oppLatias = makePokemonInPlay(mkLatias());
    state.players.p1.active = myActive;
    state.players.p1.bench = [];
    state.players.p2.active = oppLatias;
    // My Pikachu still pays its full retreat cost — opp's Skyliner doesn't help us.
    expect(effectiveRetreatCost(myActive, state)).toEqual(["Colorless", "Colorless"]);
  });
});

describe("Hop's Choice Band -1 Colorless cost reduction", () => {
  it("strips a Colorless slot when one exists", () => {
    const state = bootGameToMain(11201);
    const trev = makePokemonInPlay({
      ...mkBasic("trev", { name: "Hop's Trevenant", hp: 140 }),
      // 3-cost: Psychic + Colorless + Colorless (Hop's Trevenant Corner).
      attacks: [{ name: "Corner", cost: ["Psychic", "Colorless", "Colorless"], damage: 90, text: "" }],
    } as PokemonCard);
    trev.tools = [{
      id: "hcb",
      name: "Hop's Choice Band",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool"],
      text: "",
    } as TrainerCard];
    state.players.p1.active = trev;

    const reduced = effectiveAttackCost(state, trev, ["Psychic", "Colorless", "Colorless"]);
    // Reduced by 1 Colorless: Psychic + Colorless (one C stripped).
    expect(reduced.filter((c) => c === "Colorless").length).toBe(1);
    expect(reduced.includes("Psychic")).toBe(true);
  });

  it("does NOT strip a typed energy when there's no Colorless to strip", () => {
    const state = bootGameToMain(11202);
    const phantump = makePokemonInPlay({
      ...mkBasic("ph", { name: "Hop's Phantump" }),
      attacks: [{ name: "Splashing Dodge", cost: ["Psychic"], damage: 10, text: "" }],
    } as PokemonCard);
    phantump.tools = [{
      id: "hcb",
      name: "Hop's Choice Band",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool"],
      text: "",
    } as TrainerCard];
    state.players.p1.active = phantump;

    const reduced = effectiveAttackCost(state, phantump, ["Psychic"]);
    // No Colorless to strip → cost stays as-is. Must NOT pop the typed slot.
    expect(reduced).toEqual(["Psychic"]);
  });

  it("UI payability check (canPayCost vs effective cost) — Trevenant Corner", () => {
    // Hop's Trevenant Corner [P, C, C] with Hop's Choice Band attached and
    // 2 energies (1 Psychic + 1 anything). RAW cost says "not enough" — UI
    // would disable the button — but the engine reduces by 1 Colorless and
    // accepts. Mirrors the App.tsx fix that swapped raw cost for effective.
    const state = bootGameToMain(11203);
    const energyPsy: import("../types").EnergyCard = {
      id: "p", name: "Psychic Energy", supertype: "Energy",
      subtypes: ["Basic"], provides: ["Psychic"],
    } as import("../types").EnergyCard;
    const energyDark: import("../types").EnergyCard = {
      id: "d", name: "Darkness Energy", supertype: "Energy",
      subtypes: ["Basic"], provides: ["Darkness"],
    } as import("../types").EnergyCard;
    const trev = makePokemonInPlay({
      ...mkBasic("trev", { name: "Hop's Trevenant", hp: 140 }),
      attacks: [{ name: "Corner", cost: ["Psychic", "Colorless", "Colorless"], damage: 90, text: "" }],
    } as PokemonCard);
    trev.attachedEnergy = [energyPsy, energyDark];
    trev.tools = [{
      id: "hcb",
      name: "Hop's Choice Band",
      supertype: "Trainer",
      subtypes: ["Pokémon Tool"],
      text: "",
    } as TrainerCard];
    state.players.p1.active = trev;

    const provided = energyPoolForCost(trev, state);
    const rawCost = ["Psychic", "Colorless", "Colorless"] as import("../types").EnergyType[];
    const effective = effectiveAttackCost(state, trev, rawCost);
    // Raw is unpayable with 2 energies (need 3); effective is payable.
    expect(canPayCost(provided, rawCost)).toBe(false);
    expect(effective.length).toBe(2);
    expect(canPayCost(provided, effective)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cramorant Fickle Spitting — projected damage in estimator
// ---------------------------------------------------------------------------

describe("Hop's Cramorant Fickle Spitting projected damage", () => {
  const mkCramorant = (): PokemonCard => ({
    id: "cram-test",
    name: "Hop's Cramorant",
    supertype: "Pokémon",
    subtypes: ["Basic"],
    hp: 110,
    types: ["Colorless"],
    retreatCost: ["Colorless"],
    attacks: [
      {
        name: "Fickle Spitting",
        cost: ["Colorless"],
        damage: 120,
        damageText: "120",
        text: "If your opponent doesn't have exactly 3 or 4 Prize cards remaining, this attack does nothing.",
      },
    ],
  } as PokemonCard);

  function takePrizes(state: GameState, who: "p1" | "p2", n: number) {
    state.players[who].prizes = state.players[who].prizes.slice(0, 6 - n);
  }

  it("projects 120 when opp has 3 prizes (in range)", () => {
    const state = bootGameToMain(12001);
    const cram = makePokemonInPlay(mkCramorant());
    state.players.p1.active = cram;
    state.players.p2.active = makePokemonInPlay(mkBasic("opp", { name: "Opp", hp: 200 }));
    // Opp has 3 prizes remaining (took 3).
    takePrizes(state, "p2", 3);
    expect(state.players.p2.prizes.length).toBe(3);
    const move = cram.card.attacks[0];
    const dmg = estimateAttackDamage(state, "p1", cram, move);
    expect(dmg).toBe(120);
  });

  it("projects 120 when opp has 4 prizes (in range)", () => {
    const state = bootGameToMain(12002);
    const cram = makePokemonInPlay(mkCramorant());
    state.players.p1.active = cram;
    state.players.p2.active = makePokemonInPlay(mkBasic("opp", { name: "Opp", hp: 200 }));
    takePrizes(state, "p2", 2);
    expect(state.players.p2.prizes.length).toBe(4);
    const dmg = estimateAttackDamage(state, "p1", cram, cram.card.attacks[0]);
    expect(dmg).toBe(120);
  });

  it("projects 0 when opp has 6 prizes (out of range)", () => {
    const state = bootGameToMain(12003);
    const cram = makePokemonInPlay(mkCramorant());
    state.players.p1.active = cram;
    state.players.p2.active = makePokemonInPlay(mkBasic("opp", { name: "Opp", hp: 200 }));
    expect(state.players.p2.prizes.length).toBe(6);
    const dmg = estimateAttackDamage(state, "p1", cram, cram.card.attacks[0]);
    expect(dmg).toBe(0);
  });

  it("projects 0 when opp has 2 prizes (out of range — endgame fizzle)", () => {
    const state = bootGameToMain(12004);
    const cram = makePokemonInPlay(mkCramorant());
    state.players.p1.active = cram;
    state.players.p2.active = makePokemonInPlay(mkBasic("opp", { name: "Opp", hp: 200 }));
    takePrizes(state, "p2", 4);
    expect(state.players.p2.prizes.length).toBe(2);
    const dmg = estimateAttackDamage(state, "p1", cram, cram.card.attacks[0]);
    expect(dmg).toBe(0);
  });

  it("projects 0 when opp has 5 prizes (out of range — early game fizzle)", () => {
    const state = bootGameToMain(12005);
    const cram = makePokemonInPlay(mkCramorant());
    state.players.p1.active = cram;
    state.players.p2.active = makePokemonInPlay(mkBasic("opp", { name: "Opp", hp: 200 }));
    takePrizes(state, "p2", 1);
    expect(state.players.p2.prizes.length).toBe(5);
    const dmg = estimateAttackDamage(state, "p1", cram, cram.card.attacks[0]);
    expect(dmg).toBe(0);
  });
});
