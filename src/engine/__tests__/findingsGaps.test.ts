// v2.1 — close the four "fix landed but not directly tested" gaps from
// docs/FINDINGS.md.
//
// 1. AI lookahead through `pendingPromoteQueue`: both-Active-KO sets the
//    queue; defender promotes first (non-active-player rule), then the
//    active player drains the queue. `resolveAiPendingPromote` must walk
//    each player in turn.
// 2. Mid-queue game-over: the queued player has no bench when dequeued
//    (everyone KO'd). The safety net at ai.ts:200 must end the game
//    cleanly without re-entering picker UI.
// 3. Non-terminal + terminal `pendingPromote` phase mixing: Run Away Draw
//    sets pendingPromote with `phase = "main"` and no continuation; an
//    attack-KO later in the same game sets pendingPromote with
//    `phase = "promoteActive"` and `onPromoteResolved = "endTurn"`. The
//    callbacks must fire in order.
// 4. Passive attack/damage abilities firing in real `executeAttackHit`:
//    helpers (`passiveAttackBonus` / `passiveDamageReduction`) are
//    unit-tested; the integration through the production attack pipeline
//    is the gap. Cover one passive bonus + one passive reduction.
//
// Uses the DSL where it cleanly maps to a verb (`setupTestGame`,
// `attack`); falls through to direct state shaping for the queue
// fixtures, which can't be reached from a UI-style action sequence
// alone.

import { describe, it, expect } from "vitest";
import { setupTestGame } from "./helpers/gameTestHelpers";
import { attack, promoteBenchToActive } from "../actions";
import { activateAbility } from "../abilities";
import { resolveAiPendingPromote } from "../ai";
import type {
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
} from "../types";

// Re-reads through a function so TS widens the narrowing left over from
// assigning `state.players[..].active = null` earlier in the test.
function activeOf(state: GameState, pid: PlayerId): PokemonInPlay | null {
  return state.players[pid].active;
}

function inPlay(card: PokemonCard, instanceId: string): PokemonInPlay {
  return {
    instanceId,
    card,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  };
}

function basic(name: string, opts: Partial<PokemonCard> = {}): PokemonCard {
  return {
    id: `mock-${name}`,
    name,
    supertype: "Pokémon",
    subtypes: ["Basic"],
    hp: 100,
    types: ["Colorless"] as EnergyType[],
    attacks: [],
    retreatCost: [],
    weaknesses: [],
    resistances: [],
    ...opts,
  } as PokemonCard;
}

function grassEnergy(): EnergyCard {
  return {
    id: "mock-grass",
    name: "Basic Grass Energy",
    supertype: "Energy",
    subtypes: ["Basic"],
    provides: ["Grass"],
  } as EnergyCard;
}

describe("FINDINGS gap 1 — AI lookahead through pendingPromoteQueue", () => {
  it("resolveAiPendingPromote drains both queued players in turn", () => {
    const state = setupTestGame({ seed: 42 });
    // Direct shaping: simulate the post-mutual-KO state where both players
    // need to promote and both have bench candidates. The pre-fix bug was
    // that the queue silently dropped; this test pins that the AI walks
    // through both entries to completion.
    state.players.p1.active = null;
    state.players.p2.active = null;
    state.players.p1.bench = [inPlay(basic("P1Bench"), "p1-b")];
    state.players.p2.bench = [inPlay(basic("P2Bench"), "p2-b")];
    state.pendingPromote = "p2";
    state.pendingPromoteQueue = ["p1"];
    state.phase = "promoteActive";

    // First AI promote: defender (p2) goes first.
    const r1 = resolveAiPendingPromote(state, "p2");
    expect(r1).toBe(true);
    expect(activeOf(state, "p2")?.card.name).toBe("P2Bench");
    // Queue drained into pendingPromote, phase still promoteActive.
    expect(state.pendingPromote).toBe("p1");
    expect(state.pendingPromoteQueue).toHaveLength(0);
    expect(state.phase).toBe("promoteActive");

    // Second AI promote: active (p1) closes out.
    const r2 = resolveAiPendingPromote(state, "p1");
    expect(r2).toBe(true);
    expect(activeOf(state, "p1")?.card.name).toBe("P1Bench");
    expect(state.pendingPromote).toBeNull();
    expect(state.pendingPromoteQueue).toHaveLength(0);
  });
});

describe("FINDINGS gap 2 — mid-queue game-over (queued player has no bench)", () => {
  it("ends the game cleanly when the dequeued player can't promote", () => {
    const state = setupTestGame({ seed: 43 });
    state.players.p1.active = null;
    state.players.p2.active = null;
    state.players.p1.bench = [inPlay(basic("P1Bench"), "p1-b")];
    // p2 has nothing to promote into when dequeued.
    state.players.p2.bench = [];
    state.pendingPromote = "p1";
    state.pendingPromoteQueue = ["p2"];
    state.phase = "promoteActive";

    // p1 promotes successfully; queue moves p2 into pendingPromote.
    expect(resolveAiPendingPromote(state, "p1")).toBe(true);
    expect(state.pendingPromote).toBe("p2");
    expect(activeOf(state, "p1")?.card.name).toBe("P1Bench");

    // p2 has no bench: safety net wins for p1 and clears all promote state.
    expect(resolveAiPendingPromote(state, "p2")).toBe(true);
    expect(state.phase).toBe("gameOver");
    expect(state.winner).toBe("p1");
    expect(state.pendingPromote).toBeNull();
    expect(state.pendingPromoteQueue).toHaveLength(0);
  });
});

describe("FINDINGS gap 3 — non-terminal + terminal pendingPromote mixing", () => {
  it("Run Away Draw (phase=main, no continuation) then attack-KO (phase=promoteActive, endTurn)", () => {
    const state = setupTestGame({ seed: 44 });
    const ap = state.activePlayer;
    const oppId: PlayerId = ap === "p1" ? "p2" : "p1";
    const apl = state.players[ap];
    const opl = state.players[oppId];

    // === Phase A: non-terminal pendingPromote via Run Away Draw ===
    const dudunsparce: PokemonCard = {
      id: "mock-dudunsparce",
      name: "Dudunsparce",
      supertype: "Pokémon",
      subtypes: ["Stage 1"],
      hp: 130,
      types: ["Colorless"],
      attacks: [],
      retreatCost: ["Colorless"],
      weaknesses: [],
      resistances: [],
      abilities: [
        {
          name: "Run Away Draw",
          type: "Ability",
          text: "Once during your turn, you may draw 3 cards. Then, shuffle this Pokémon and all attached cards into your deck.",
          effect: { kind: "shuffleSelfIntoDeck", oncePerTurn: true },
        },
      ],
    } as PokemonCard;
    apl.active = inPlay(dudunsparce, "ap-dudun");
    apl.bench = [
      inPlay(basic("APBench1"), "ap-b1"),
      inPlay(basic("APBench2"), "ap-b2"),
    ];

    const r1 = activateAbility(state, ap, apl.active!.instanceId, 0);
    expect(r1.ok).toBe(true);
    // Non-terminal: phase stays main, no scheduled continuation.
    expect(state.pendingPromote).toBe(ap);
    expect(state.phase).toBe("main");
    expect(state.onPromoteResolved).toBeNull();

    // Resolve the non-terminal promote — drops back to main, no callback.
    promoteBenchToActive(state, ap, 0);
    expect(state.pendingPromote).toBeNull();
    expect(state.phase).toBe("main");
    expect(apl.active?.card.name).toBe("APBench1");

    // === Phase B: terminal pendingPromote via attack-KO ===
    // Replace AP active with a 1-shot attacker (free cost, 200 damage).
    const oneShot: PokemonCard = basic("OneShot", {
      attacks: [{ name: "Smash", cost: [], damage: 200, text: "" }],
    });
    apl.active = inPlay(oneShot, "ap-oneshot");
    // Defender at fragile HP so the attack KOs cleanly.
    const fragile: PokemonCard = basic("Fragile", { hp: 60 });
    opl.active = inPlay(fragile, "opp-fragile");
    opl.bench = [inPlay(basic("OppBench"), "opp-b")];

    // Track turn so endTurn-triggered side-effects are observable.
    const turnBefore = state.turn;
    const activeBefore = state.activePlayer;

    const ar = attack(state, ap, 0);
    expect(ar.ok).toBe(true);
    // Terminal: defender must promote, phase = promoteActive, endTurn queued.
    expect(state.pendingPromote).toBe(oppId);
    expect(state.phase).toBe("promoteActive");
    expect(state.onPromoteResolved).toBe("endTurn");

    // Resolve: endTurn fires after promotion, advancing turn + active player.
    promoteBenchToActive(state, oppId, 0);
    expect(state.pendingPromote).toBeNull();
    expect(state.onPromoteResolved).toBeNull();
    expect(opl.active?.card.name).toBe("OppBench");
    // endTurn ran as the continuation: turn advanced and active player flipped.
    expect(state.turn).toBeGreaterThan(turnBefore);
    expect(state.activePlayer).not.toBe(activeBefore);
  });
});

describe("FINDINGS gap 4 — passive abilities firing in real executeAttackHit", () => {
  // Both sub-cases set up a controlled attacker / defender pair, give the
  // attacker enough energy for a free-cost attack, and assert on the
  // damage counter that the production pipeline lands on the defender.

  function primeAttackerWithFreeAttack(
    state: GameState,
    ap: PlayerId,
    move: { name: string; cost: EnergyType[]; damage: number; types?: EnergyType[] },
    attackerOpts: Partial<PokemonCard> = {},
  ) {
    const apl = state.players[ap];
    const attackerCard: PokemonCard = basic("Attacker", {
      types: (move.types ?? ["Colorless"]) as EnergyType[],
      attacks: [{ name: move.name, cost: move.cost, damage: move.damage, text: "" }],
      ...attackerOpts,
    });
    apl.active = inPlay(attackerCard, "ap-attacker");
    return apl.active!;
  }

  it("passive attack bonus (Powerful a-Salt on bench) lands +30 in real attack pipeline", () => {
    const state = setupTestGame({ seed: 51 });
    const ap = state.activePlayer;
    const oppId: PlayerId = ap === "p1" ? "p2" : "p1";
    const apl = state.players[ap];
    const opl = state.players[oppId];

    // Fighting attacker (ensures Powerful a-Salt's appliesTo gate fires).
    primeAttackerWithFreeAttack(
      state,
      ap,
      { name: "Quick Punch", cost: [], damage: 50, types: ["Fighting"] },
    );
    // Bench: Garganacl with Powerful a-Salt (+30 to your Fighting attacks).
    const garganacl: PokemonCard = {
      ...basic("Garganacl", { types: ["Fighting"], hp: 180 }),
      subtypes: ["Stage 2"],
      abilities: [
        {
          name: "Powerful a-Salt",
          type: "Ability",
          text: "Attacks used by your Fighting Pokémon do 30 more damage to your opponent's Active Pokémon (before applying Weakness and Resistance).",
        },
      ],
    } as PokemonCard;
    apl.bench = [inPlay(garganacl, "ap-garg")];
    // Tanky defender so the 80 damage doesn't KO and we can read the counter.
    opl.active = inPlay(
      basic("Defender", { hp: 200, weaknesses: [], resistances: [] }),
      "opp-def",
    );
    opl.bench = [];

    const ar = attack(state, ap, 0);
    expect(ar.ok).toBe(true);
    // 50 base + 30 passive = 80 (no weakness, no resistance, no other mods).
    expect(opl.active!.damage).toBe(80);
  });

  it("passive damage reduction (Solid Shell on defender) cuts -20 in real attack pipeline", () => {
    const state = setupTestGame({ seed: 52 });
    const ap = state.activePlayer;
    const oppId: PlayerId = ap === "p1" ? "p2" : "p1";
    const apl = state.players[ap];
    const opl = state.players[oppId];

    primeAttackerWithFreeAttack(
      state,
      ap,
      { name: "Tackle", cost: [], damage: 50 },
    );
    apl.bench = [];
    // Defender: Turtwig with Solid Shell (-20 from any attack).
    const turtwig: PokemonCard = {
      ...basic("Turtwig", { types: ["Grass"], hp: 80 }),
      abilities: [
        {
          name: "Solid Shell",
          type: "Ability",
          text: "This Pokémon takes 20 less damage from attacks (after applying Weakness and Resistance).",
        },
      ],
    } as PokemonCard;
    opl.active = inPlay(turtwig, "opp-turtwig");
    // Need bench so a KO from the test doesn't cascade into pendingPromote.
    opl.bench = [inPlay(basic("OppBench"), "opp-b")];

    const ar = attack(state, ap, 0);
    expect(ar.ok).toBe(true);
    // 50 base - 20 passive reduction = 30.
    expect(opl.active!.damage).toBe(30);
  });

  it("passive bonus and reduction stack additively in the same hit", () => {
    // Defensive contract: bonus and reduction touch independent code paths
    // (turnAttackBonus → passiveAttackBonus pre-W/R; passiveDamageReduction
    // post-W/R). They must compose without one cancelling the other.
    const state = setupTestGame({ seed: 53 });
    const ap = state.activePlayer;
    const oppId: PlayerId = ap === "p1" ? "p2" : "p1";
    const apl = state.players[ap];
    const opl = state.players[oppId];

    primeAttackerWithFreeAttack(
      state,
      ap,
      { name: "Quick Punch", cost: [], damage: 50, types: ["Fighting"] },
    );
    const garganacl: PokemonCard = {
      ...basic("Garganacl", { types: ["Fighting"], hp: 180 }),
      subtypes: ["Stage 2"],
      abilities: [
        {
          name: "Powerful a-Salt",
          type: "Ability",
          text: "Attacks used by your Fighting Pokémon do 30 more damage to your opponent's Active Pokémon (before applying Weakness and Resistance).",
        },
      ],
    } as PokemonCard;
    apl.bench = [inPlay(garganacl, "ap-garg")];
    const turtwig: PokemonCard = {
      ...basic("Turtwig", { types: ["Grass"], hp: 200, weaknesses: [], resistances: [] }),
      abilities: [
        {
          name: "Solid Shell",
          type: "Ability",
          text: "This Pokémon takes 20 less damage from attacks (after applying Weakness and Resistance).",
        },
      ],
    } as PokemonCard;
    opl.active = inPlay(turtwig, "opp-turtwig");
    opl.bench = [];

    const ar = attack(state, ap, 0);
    expect(ar.ok).toBe(true);
    // 50 base + 30 passive bonus = 80, then -20 passive reduction = 60.
    expect(opl.active!.damage).toBe(60);
  });
});

// Suppress unused-import warning for grassEnergy if the test bodies above
// don't reference it; kept available because callers commonly need a
// real EnergyCard when extending these fixtures with paid attacks.
void grassEnergy;
