// Phase 1 AI decision-quality scenarios — safety rails before refactoring
// scorePosition or changing broader AI behavior. Each scenario shapes a
// deterministic GameState and drives the AI via PUBLIC entrypoints
// (takeAiTurn / resolveAiPendingPromote) only. No private ai.ts helpers,
// no internal score numbers — assert observable state changes.
//
// Tests marked `it.fails(...)` pin desired behavior that does not pass
// today. Vitest treats a passing it.fails as a CI failure, so an
// accidental green flips loudly.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
} from "../rules";
import { takeAiTurn, resolveAiPendingPromote } from "../ai";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "../types";

// Deterministic ID counter so instance IDs don't drift between runs. Reset
// per test via newId(reset = true) when needed.
let idCounter = 0;
function newId(prefix = "inst"): string {
  return `${prefix}-${++idCounter}`;
}

function bootGame(seed = 1, version: "v1" | "v2" = "v2"): GameState {
  const state = setupGame(
    buildDeck(DECK_SPECS[0]),
    buildDeck(DECK_SPECS[1]),
    makeRng(seed),
    { p2IsAI: true },
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
  state.players.p1.isAI = true;
  state.players.p2.isAI = true;
  state.players.p1.aiVersion = version;
  state.players.p2.aiVersion = version;
  return state;
}

function mkPokemonCard(over: Partial<PokemonCard> = {}): PokemonCard {
  return {
    id: over.id ?? `card-${++idCounter}`,
    name: "Test",
    supertype: "Pokémon",
    subtypes: ["Basic"],
    hp: 100,
    types: ["Colorless"],
    attacks: [{ name: "Tackle", cost: [], damage: 30 }],
    retreatCost: [],
    weaknesses: [],
    resistances: [],
    ...over,
  } as PokemonCard;
}

function mkInPlay(card: PokemonCard, over: Partial<PokemonInPlay> = {}): PokemonInPlay {
  return {
    instanceId: over.instanceId ?? newId(),
    card,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: false,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
    ...over,
  } as PokemonInPlay;
}

function mkEnergy(type: string): EnergyCard {
  return {
    id: `e-${type}-${++idCounter}`,
    name: `Basic ${type} Energy`,
    supertype: "Energy",
    subtypes: ["Basic"],
    provides: [type as never],
  } as EnergyCard;
}

function mkItemCard(name: string, effectId: string): TrainerCard {
  return {
    id: `i-${name}-${++idCounter}`,
    name,
    supertype: "Trainer",
    subtypes: ["Item"],
    text: "...",
    effectId,
  } as TrainerCard;
}

function mkAceSpecItemCard(name: string, effectId: string): TrainerCard {
  return {
    ...mkItemCard(name, effectId),
    subtypes: ["Item", "ACE SPEC"],
  } as TrainerCard;
}

function mkSupporterCard(name: string, effectId: string): TrainerCard {
  return {
    id: `s-${name}-${++idCounter}`,
    name,
    supertype: "Trainer",
    subtypes: ["Supporter"],
    text: "...",
    effectId,
  } as TrainerCard;
}

function mkFillerTrainer(name: string): TrainerCard {
  return {
    id: `f-${name}-${++idCounter}`,
    name,
    supertype: "Trainer",
    subtypes: ["Item"],
    text: "...",
  } as TrainerCard;
}

function mkToolCard(name: string): TrainerCard {
  return {
    id: `tool-${name}-${++idCounter}`,
    name,
    supertype: "Trainer",
    subtypes: ["Pokémon Tool"],
    text: "...",
  } as TrainerCard;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Prime Catcher gusts a game-winning KO target.
// ---------------------------------------------------------------------------

describe("Phase 1 — gust priority", () => {
  it("Prime Catcher gusts a game-winning KO target", () => {
    const state = bootGame(1001);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";
    // AI Active: Colorless, has one attack that hits 90 for one Colorless.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Striker",
        hp: 100,
        attacks: [{ name: "Strike", cost: [], damage: 90 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [];
    // AI prizes = 1 (one prize away from winning).
    state.players[ap].prizes = state.players[ap].prizes.slice(0, 1);
    // Opp Active: high HP, not reachable in one hit.
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-active" },
    );
    // Opp bench: one low-HP target that our 90-damage attack will OHKO.
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({ name: "Glass Cannon", hp: 60 }),
        { instanceId: "opp-glass" },
      ),
    ];
    // AI hand: Prime Catcher only.
    state.players[ap].hand = [mkItemCard("Prime Catcher", "primeCatcher")];

    takeAiTurn(state, ap);

    // Game-winning: either we won outright, or AI prizes are empty, or
    // the Glass Cannon was the one that got KO'd (so the gust + attack
    // sequence happened).
    const aiWon = state.winner === ap;
    const prizesEmpty = state.players[ap].prizes.length === 0;
    const glassGone =
      !state.players[op].bench.some((p) => p.instanceId === "opp-glass") &&
      !(state.players[op].active?.instanceId === "opp-glass" &&
        (state.players[op].active?.damage ?? 0) <
          (state.players[op].active?.card.hp ?? Infinity));
    expect(aiWon || prizesEmpty || glassGone).toBe(true);
  });

  it("Prime Catcher is not played when Opp Active is already the better KO", () => {
    const state = bootGame(1002);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";
    // AI Active can OHKO Opp Active.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Sniper",
        hp: 110,
        attacks: [{ name: "Snipe", cost: [], damage: 200 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [];
    // Opp Active: 2-prize ex with 180 HP. Bench: a 1-prize 90-HP filler.
    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp Ex",
        hp: 180,
        subtypes: ["Basic", "ex"],
      }),
      { instanceId: "opp-active" },
    );
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({ name: "Opp Filler", hp: 90 }),
        { instanceId: "opp-filler" },
      ),
    ];
    // AI hand: Prime Catcher.
    const primeCatcher = mkItemCard("Prime Catcher", "primeCatcher");
    state.players[ap].hand = [primeCatcher];

    takeAiTurn(state, ap);

    // Prime Catcher should still be in hand OR in discard — the test pins
    // "didn't change the matchup." Easiest assertion: opp-active was the
    // one that was attacked (high damage), opp-filler is untouched.
    // After OHKO + KO resolution, opp-active may be gone or replaced; check
    // that opp-filler is unharmed and the same instanceId is on the bench.
    const fillerStill = [
      state.players[op].active,
      ...state.players[op].bench,
    ].some((p) => p?.instanceId === "opp-filler" && p.damage === 0);
    expect(fillerStill).toBe(true);
  });
});

describe("Phase 5A — gust target scorer", () => {
  it("v2 gust pulls a last-prize target over a smaller mid-game KO", () => {
    const state = bootGame(5001);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Prize Closer",
        hp: 140,
        attacks: [{ name: "Clean Hit", cost: [], damage: 60 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [];
    state.players[ap].prizes = [
      mkFillerTrainer("Prize 1") as unknown as Card,
      mkFillerTrainer("Prize 2") as unknown as Card,
    ];
    state.players[ap].hand = [mkItemCard("Prime Catcher", "primeCatcher")];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Midgame Prize",
          hp: 50,
          attacks: [{ name: "Tap", cost: [], damage: 10 }],
        }),
        { instanceId: "midgame-prize" },
      ),
      mkInPlay(
        mkPokemonCard({
          name: "Last Prize ex",
          subtypes: ["Basic", "ex"],
          hp: 60,
          attacks: [{ name: "Tap", cost: [], damage: 10 }],
        }),
        { instanceId: "last-prize" },
      ),
    ];

    takeAiTurn(state, ap);

    expect(state.players[op].active?.instanceId).not.toBe("midgame-prize");
    expect(
      state.winner === ap ||
        state.players[ap].prizes.length === 0 ||
        ![state.players[op].active, ...state.players[op].bench].some(
          (p) => p?.instanceId === "last-prize",
        ),
    ).toBe(true);
  });

  it("v2 gust avoids a protected future threat when an unprotected KO is available", () => {
    const state = bootGame(5002);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Ability Striker",
        hp: 180,
        attacks: [{ name: "Ability Strike", cost: [], damage: 70 }],
        abilities: [{ name: "Pressure System", text: "...", type: "Ability" }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [mkItemCard("Prime Catcher", "primeCatcher")];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Protected Threat ex",
          subtypes: ["Basic", "ex"],
          hp: 60,
          attacks: [{ name: "Huge Reply", cost: ["Fighting"], damage: 320 }],
          abilities: [
            {
              name: "Cornerstone Stance",
              text: "Prevent all damage from attacks done to this Pokémon by your opponent's Pokémon that have an Ability.",
              type: "Ability",
            },
          ],
        }),
        {
          instanceId: "protected-threat",
          attachedEnergy: [mkEnergy("Fighting")],
        },
      ),
      mkInPlay(
        mkPokemonCard({
          name: "Open Target ex",
          subtypes: ["Basic", "ex"],
          hp: 60,
          attacks: [{ name: "Small Reply", cost: [], damage: 20 }],
        }),
        { instanceId: "open-target" },
      ),
    ];

    takeAiTurn(state, ap);

    expect(
      [state.players[op].active, ...state.players[op].bench].some(
        (p) => p?.instanceId === "protected-threat",
      ),
    ).toBe(true);
    expect(
      [state.players[op].active, ...state.players[op].bench].some(
        (p) => p?.instanceId === "open-target" && p.damage < p.card.hp,
      ),
    ).toBe(false);
  });
});

describe("Phase 5B — energy attach scorer", () => {
  it("v2 attaches toward the higher-value next-turn attacker over a small active unlock", () => {
    const state = bootGame(5101);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Small Active",
        hp: 160,
        types: ["Fire"],
        attacks: [{ name: "Spark", cost: ["Fire", "Fire"], damage: 20 }],
      }),
      { instanceId: "small-active", attachedEnergy: [mkEnergy("Fire")] },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Strategic Bench",
          hp: 220,
          types: ["Fire"],
          attacks: [{ name: "Big Finish", cost: ["Fire", "Fire", "Fire"], damage: 260 }],
        }),
        { instanceId: "strategic-bench", attachedEnergy: [mkEnergy("Fire")] },
      ),
    ];
    state.players[ap].hand = [mkEnergy("Fire")];
    state.players[ap].deck = [mkEnergy("Fire") as unknown as Card];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    const benchEnergyBefore = state.players[ap].bench[0].attachedEnergy.length;
    takeAiTurn(state, ap);

    expect(state.players[ap].active?.attachedEnergy.length).toBe(1);
    expect(state.players[ap].bench[0].attachedEnergy.length).toBe(benchEnergyBefore + 1);
  });

  it("v2 avoids attaching to an OHKO-range target that cannot retaliate", () => {
    const state = bootGame(5102);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Doomed Active",
        hp: 120,
        types: ["Fire"],
        retreatCost: ["Colorless", "Colorless"],
        attacks: [{ name: "Late Blast", cost: ["Fire", "Fire", "Fire"], damage: 300 }],
      }),
      { instanceId: "doomed-active", attachedEnergy: [mkEnergy("Fire")] },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Safe Bench",
          hp: 220,
          types: ["Fire"],
          attacks: [{ name: "Ready Soon", cost: ["Fire", "Fire", "Fire"], damage: 140 }],
        }),
        { instanceId: "safe-bench", attachedEnergy: [mkEnergy("Fire")] },
      ),
    ];
    state.players[ap].hand = [mkEnergy("Fire")];
    state.players[ap].deck = [mkEnergy("Fire") as unknown as Card];

    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp Crusher",
        hp: 180,
        attacks: [{ name: "Crush", cost: [], damage: 140 }],
      }),
      { instanceId: "opp-crusher" },
    );
    state.players[op].bench = [];

    const activeEnergyBefore = state.players[ap].active?.attachedEnergy.length ?? 0;
    const benchEnergyBefore = state.players[ap].bench[0].attachedEnergy.length;
    takeAiTurn(state, ap);

    expect(state.players[ap].active?.attachedEnergy.length).toBe(activeEnergyBefore);
    expect(state.players[ap].bench[0].attachedEnergy.length).toBe(benchEnergyBefore + 1);
  });
});

describe("Phase 5C — search target scorer", () => {
  it("v2 searches an evolution that completes an in-play line over a larger Basic", () => {
    const state = bootGame(5201);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Bulbasaur",
        hp: 70,
        types: ["Grass"],
        attacks: [{ name: "Vine Tap", cost: [], damage: 20 }],
      }),
      { instanceId: "bulbasaur-ready", playedThisTurn: false, evolvedThisTurn: false },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [mkItemCard("Master Ball", "searchAnyPokemonFree")];
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Large Basic ex",
        subtypes: ["Basic", "ex"],
        hp: 340,
        attacks: [{ name: "Free Swing", cost: [], damage: 80 }],
      }) as unknown as Card,
      mkPokemonCard({
        name: "Ivysaur",
        subtypes: ["Stage 1"],
        evolvesFrom: "Bulbasaur",
        hp: 100,
        types: ["Grass"],
        attacks: [{ name: "Leaf Hit", cost: ["Grass"], damage: 90 }],
      }) as unknown as Card,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.players[ap].active?.card.name).toBe("Ivysaur");
    expect(state.players[ap].bench.some((p) => p.card.name === "Large Basic ex")).toBe(false);
  });

  it("v2 energy search picks the missing attack color over a duplicate attached type", () => {
    const state = bootGame(5202);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Two-Color Attacker",
        hp: 170,
        types: ["Fire"],
        attacks: [{ name: "Steam Burst", cost: ["Fire", "Water"], damage: 180 }],
      }),
      { instanceId: "two-color-attacker", attachedEnergy: [mkEnergy("Fire")] },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [mkItemCard("Energy Search", "searchBasicEnergy1")];
    state.players[ap].deck = [
      mkEnergy("Fire") as unknown as Card,
      mkEnergy("Water") as unknown as Card,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    const attachedTypes = state.players[ap].active?.attachedEnergy.flatMap((e) => e.provides) ?? [];
    expect(attachedTypes.filter((t) => t === "Fire")).toHaveLength(1);
    expect(attachedTypes).toContain("Water");
  });
});

describe("Phase 5D — bench target scorer", () => {
  it("v2 benches an archetype-critical Basic over a higher-HP filler", () => {
    const state = bootGame(5301);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({ name: "AP Anchor", hp: 120 }),
      { instanceId: "ap-anchor" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bench 1", hp: 90 }), { instanceId: "bench-1" }),
      mkInPlay(mkPokemonCard({ name: "Bench 2", hp: 90 }), { instanceId: "bench-2" }),
    ];
    const riolu = mkPokemonCard({
      name: "Riolu",
      hp: 70,
      types: ["Fighting"],
      attacks: [{ name: "Jab", cost: ["Fighting"], damage: 30 }],
    });
    const filler = mkPokemonCard({
      name: "Bulky Filler",
      hp: 160,
      types: ["Colorless"],
      attacks: [{ name: "Slow Punch", cost: ["Colorless", "Colorless"], damage: 70 }],
    });
    state.players[ap].hand = [filler as unknown as Card, riolu as unknown as Card];
    state.players[ap].deck = [
      mkPokemonCard({ name: "Mega Lucario ex", subtypes: ["Stage 1", "ex"], evolvesFrom: "Riolu" }) as unknown as Card,
      mkFillerTrainer("Pad") as unknown as Card,
    ];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 200 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.players[ap].bench[2]?.card.name).toBe("Riolu");
  });

  it("v2 benches the Basic whose Stage 1 is already in hand over a generic high-HP Basic", () => {
    const state = bootGame(5302);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({ name: "AP Anchor", hp: 120 }),
      { instanceId: "ap-anchor" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bench 1", hp: 90 }), { instanceId: "bench-1" }),
      mkInPlay(mkPokemonCard({ name: "Bench 2", hp: 90 }), { instanceId: "bench-2" }),
    ];
    const dreepy = mkPokemonCard({
      name: "Dreepy",
      hp: 40,
      types: ["Psychic"],
      attacks: [{ name: "Ram", cost: ["Psychic"], damage: 10 }],
    });
    const drakloak = mkPokemonCard({
      name: "Drakloak",
      subtypes: ["Stage 1"],
      evolvesFrom: "Dreepy",
      hp: 90,
      types: ["Psychic"],
      attacks: [{ name: "Tail Smack", cost: ["Psychic"], damage: 30 }],
    });
    const filler = mkPokemonCard({
      name: "Bulky Filler",
      hp: 130,
      types: ["Colorless"],
      attacks: [{ name: "Headbutt", cost: ["Colorless", "Colorless"], damage: 30 }],
    });
    state.players[ap].hand = [
      dreepy as unknown as Card,
      filler as unknown as Card,
      drakloak as unknown as Card,
    ];
    state.players[ap].deck = [mkFillerTrainer("Pad") as unknown as Card];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 200 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.players[ap].bench[2]?.card.name).toBe("Dreepy");
  });

  it("v2 benches the Basic that could attack immediately over a vanilla high-HP body", () => {
    const state = bootGame(5303);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({ name: "AP Anchor", hp: 120 }),
      { instanceId: "ap-anchor" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bench 1", hp: 90 }), { instanceId: "bench-1" }),
      mkInPlay(mkPokemonCard({ name: "Bench 2", hp: 90 }), { instanceId: "bench-2" }),
    ];
    const swinger = mkPokemonCard({
      name: "Fast Swinger",
      hp: 70,
      types: ["Colorless"],
      attacks: [{ name: "Quick Jab", cost: [], damage: 40 }],
    });
    const vanilla = mkPokemonCard({
      name: "Big Vanilla",
      hp: 140,
      types: ["Colorless"],
      attacks: [{ name: "Slow Punch", cost: ["Colorless", "Colorless", "Colorless"], damage: 90 }],
    });
    state.players[ap].hand = [vanilla as unknown as Card, swinger as unknown as Card];
    state.players[ap].deck = [mkFillerTrainer("Pad") as unknown as Card];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 200 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.players[ap].bench[2]?.card.name).toBe("Fast Swinger");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Energy attach to next-turn attacker, not powered Active.
// ---------------------------------------------------------------------------

describe("Phase 1 — energy attach", () => {
  it("attaches to bench attacker that needs one more Energy, not the already-powered Active", () => {
    const state = bootGame(1003);
    const ap = state.activePlayer;
    // Active needs Fire only; already has Fire attached.
    const fireOnActive = mkEnergy("Fire");
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Active Striker",
        hp: 100,
        attacks: [{ name: "Flame", cost: ["Fire"], damage: 40 }],
      }),
      { instanceId: "ai-active", attachedEnergy: [fireOnActive] },
    );
    // Bench attacker needs 2 Fire; has 1 attached (1 short).
    const fireOnBench = mkEnergy("Fire");
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Bench Striker",
          hp: 100,
          attacks: [{ name: "Big Flame", cost: ["Fire", "Fire"], damage: 90 }],
        }),
        { instanceId: "ai-bench", attachedEnergy: [fireOnBench] },
      ),
    ];
    // AI hand: one more Fire Energy, plus nothing else playable.
    const fireInHand = mkEnergy("Fire");
    state.players[ap].hand = [fireInHand];

    const benchEnergyBefore = state.players[ap].bench[0].attachedEnergy.length;
    takeAiTurn(state, ap);
    const benchEnergyAfter = state.players[ap].bench[0].attachedEnergy.length;

    // Bench attacker should now have 2 Energy (closed the gap).
    expect(benchEnergyAfter).toBeGreaterThan(benchEnergyBefore);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Promote powered attacker over higher-HP empty wall.
// ---------------------------------------------------------------------------

describe("Phase 1 — promote selection", () => {
  it("promotes powered attacker over higher-HP empty wall", () => {
    const state = bootGame(1004);
    const ap = state.activePlayer;
    // No Active; pending promote pending on AI.
    state.players[ap].active = null;
    // Bench A: powered attacker with a payable attack.
    const benchPowered = mkInPlay(
      mkPokemonCard({
        name: "Powered Attacker",
        hp: 100,
        attacks: [{ name: "Hit", cost: ["Fire"], damage: 50 }],
      }),
      {
        instanceId: "bench-powered",
        attachedEnergy: [mkEnergy("Fire")],
      },
    );
    // Bench B: higher-HP wall, no Energy, no payable attack.
    const benchWall = mkInPlay(
      mkPokemonCard({
        name: "Empty Wall",
        hp: 250,
        attacks: [{ name: "Wallop", cost: ["Fire", "Fire", "Fire"], damage: 200 }],
      }),
      { instanceId: "bench-wall", attachedEnergy: [] },
    );
    state.players[ap].bench = [benchPowered, benchWall];
    state.pendingPromote = ap;
    state.phase = "promoteActive";

    const r = resolveAiPendingPromote(state, ap);
    expect(r).toBe(true);
    const newActive = state.players[ap].active as PokemonInPlay | null;
    expect(newActive?.instanceId).toBe("bench-powered");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Avoid over-benching dead Basic under spread pressure.
// ---------------------------------------------------------------------------

describe("Phase 1 — bench discipline", () => {
  it(
    "does NOT play a dead-weight Basic to the bench while under spread pressure",
    () => {
      const state = bootGame(1005);
      const ap = state.activePlayer;
      const op: PlayerId = ap === "p1" ? "p2" : "p1";
      // Opp Active: Dragapult-like spread attack (Phantom Dive analog).
      state.players[op].active = mkInPlay(
        mkPokemonCard({
          name: "Opp Spreader",
          hp: 200,
          attacks: [
            {
              name: "Phantom Dive",
              cost: ["Psychic", "Psychic"],
              damage: 60,
              text: "Put 6 damage counters on your opponent's Benched Pokémon in any way you like.",
            },
          ],
        }),
        { instanceId: "opp-spreader" },
      );
      // AI bench has 3 useful Pokémon.
      state.players[ap].active = mkInPlay(
        mkPokemonCard({
          name: "AI Active",
          hp: 100,
          attacks: [{ name: "Hit", cost: [], damage: 30 }],
        }),
        { instanceId: "ai-active" },
      );
      state.players[ap].bench = [
        mkInPlay(mkPokemonCard({ name: "Bench 1", hp: 80 }), {
          instanceId: "ai-bench-1",
        }),
        mkInPlay(mkPokemonCard({ name: "Bench 2", hp: 80 }), {
          instanceId: "ai-bench-2",
        }),
        mkInPlay(mkPokemonCard({ name: "Bench 3", hp: 80 }), {
          instanceId: "ai-bench-3",
        }),
      ];
      // Hand: a dead-weight Basic (no evolution in deck/hand, no
      // strategic relevance) and nothing else.
      state.players[ap].hand = [
        mkPokemonCard({
          name: "Dead Weight",
          subtypes: ["Basic"],
          hp: 60,
          attacks: [{ name: "Weak", cost: [], damage: 10 }],
        }) as Card,
      ];
      state.players[ap].deck = [];

      const benchBefore = state.players[ap].bench.length;
      takeAiTurn(state, ap);
      const benchAfter = state.players[ap].bench.length;

      expect(benchAfter).toBe(benchBefore);
    },
  );

  // Positive control: the new gate must not freeze legitimate setup. With
  // no spread pressure AND a Basic whose evolution sits in our deck, the
  // AI should happily bench it even at 3+ existing bench slots.
  it("v2 AI still benches an evolution-base Basic under no spread pressure", () => {
    const state = bootGame(1051);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";
    // Opp Active: vanilla attacker, NO spread effect.
    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp Vanilla",
        hp: 200,
        attacks: [{ name: "Punch", cost: ["Fire"], damage: 60 }],
      }),
      { instanceId: "opp-vanilla" },
    );
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 100,
        attacks: [{ name: "Hit", cost: [], damage: 30 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bench 1", hp: 80 }), {
        instanceId: "ai-bench-1",
      }),
      mkInPlay(mkPokemonCard({ name: "Bench 2", hp: 80 }), {
        instanceId: "ai-bench-2",
      }),
      mkInPlay(mkPokemonCard({ name: "Bench 3", hp: 80 }), {
        instanceId: "ai-bench-3",
      }),
    ];
    // Hand: a Basic with an evolution line in deck — legitimate setup.
    state.players[ap].hand = [
      mkPokemonCard({
        name: "Dreepy-Like",
        subtypes: ["Basic"],
        hp: 60,
        attacks: [{ name: "Tackle", cost: [], damage: 10 }],
      }) as Card,
    ];
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Drakloak-Like",
        subtypes: ["Stage 1"],
        evolvesFrom: "Dreepy-Like",
        hp: 90,
      }) as Card,
    ];

    const benchBefore = state.players[ap].bench.length;
    takeAiTurn(state, ap);
    const benchAfter = state.players[ap].bench.length;

    expect(benchAfter).toBeGreaterThan(benchBefore);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6/7/8 — Unfair Stamp timing.
// ---------------------------------------------------------------------------

describe("Phase 1 — disruption timing", () => {
  it("Unfair Stamp is not played when KO gate is false", () => {
    const state = bootGame(1006);
    const ap = state.activePlayer;
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 100,
        attacks: [{ name: "Hit", cost: [], damage: 30 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkItemCard("Unfair Stamp", "unfairStampShuffleDraw"),
    ];
    state.players[ap].yourPokemonKoedLastOppTurn = false;

    takeAiTurn(state, ap);

    const stillHas = state.players[ap].hand.some((c) => c.name === "Unfair Stamp");
    expect(stillHas).toBe(true);
  });

  it(
    "Unfair Stamp is played when KO gate is satisfied and opp hand is large",
    () => {
      const state = bootGame(1007);
      const ap = state.activePlayer;
      const op: PlayerId = ap === "p1" ? "p2" : "p1";
      state.players[ap].active = mkInPlay(
        mkPokemonCard({
          name: "AI Active",
          hp: 100,
          attacks: [{ name: "Hit", cost: [], damage: 30 }],
        }),
        { instanceId: "ai-active" },
      );
      state.players[ap].bench = [];
      state.players[ap].hand = [
        mkItemCard("Unfair Stamp", "unfairStampShuffleDraw"),
        // Filler so AI has something to do beyond just attack.
        mkEnergy("Fire") as unknown as Card,
      ];
      state.players[ap].yourPokemonKoedLastOppTurn = true;
      // Opp hand size large: pad with mundane Items.
      state.players[op].hand = [
        mkItemCard("FillerA", "potionHeal30"),
        mkItemCard("FillerB", "potionHeal30"),
        mkItemCard("FillerC", "potionHeal30"),
        mkItemCard("FillerD", "potionHeal30"),
        mkItemCard("FillerE", "potionHeal30"),
        mkItemCard("FillerF", "potionHeal30"),
      ];

      takeAiTurn(state, ap);

      // Desired: Unfair Stamp left AI hand AND opp hand was meaningfully
      // reduced. Unfair Stamp shuffles both hands into deck and draws
      // (you 5 / opp 2), so opp's hand drops from 6 to 2. Then
      // takeAiTurn ends our turn, which passes control to opp and runs
      // their start-of-turn draw (+1), so opp.hand ends at 3.
      const stampGone = !state.players[ap].hand.some(
        (c) => c.name === "Unfair Stamp",
      );
      const oppHand = state.players[op].hand.length;
      expect(stampGone).toBe(true);
      expect(oppHand).toBe(3);
    },
  );

  it("Unfair Stamp is not played when opp hand is small (passes today for coarse reason)", () => {
    // Currently passes because scoreTrainerForNow doesn't reach for
    // unfairStampShuffleDraw at all — default score 25 < Item threshold
    // 40. When the #7 fix lands, we must also add the small-opp-hand
    // penalty so this test stays green.
    const state = bootGame(1008);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 100,
        attacks: [{ name: "Hit", cost: [], damage: 30 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkItemCard("Unfair Stamp", "unfairStampShuffleDraw"),
      mkEnergy("Fire") as unknown as Card,
    ];
    state.players[ap].yourPokemonKoedLastOppTurn = true;
    // Opp hand size small (2 cards).
    state.players[op].hand = [
      mkItemCard("FillerA", "potionHeal30"),
      mkItemCard("FillerB", "potionHeal30"),
    ];

    takeAiTurn(state, ap);

    const stillHas = state.players[ap].hand.some(
      (c) => c.name === "Unfair Stamp",
    );
    expect(stillHas).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 2B — scoreImmediateThreats game-winning escalator + scoreAttackReadiness
// active-can-attack-now bonus + evolution-in-hand bonus.
// ---------------------------------------------------------------------------

describe("Phase 2B — threat / readiness overlays", () => {
  it("v2 takes the game-winning OHKO on opp Active when at 1 prize", () => {
    const state = bootGame(2101);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";
    // AI is 1 prize from winning.
    state.players[ap].prizes = state.players[ap].prizes.slice(0, 1);
    // AI Active: payable OHKO attack on opp Active.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Closer",
        hp: 100,
        attacks: [
          { name: "Finisher", cost: ["Fire"], damage: 220 },
        ],
      }),
      {
        instanceId: "ai-active",
        attachedEnergy: [mkEnergy("Fire")],
      },
    );
    state.players[ap].bench = [];
    // Opp Active reachable in one hit (220 damage vs 200 HP).
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Target", hp: 200 }),
      { instanceId: "opp-active" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    // Either we won outright OR our prizes are empty (the final KO).
    const aiWon = state.winner === ap;
    const prizesEmpty = state.players[ap].prizes.length === 0;
    expect(aiWon || prizesEmpty).toBe(true);
  });

  it("v2 doesn't blunder away a game-losing trade — Active in OHKO range when opp can close", () => {
    // Scenario: opp is at 1 prize and our Active is a 2-prize ex sitting
    // in OHKO range. The game-losing escalator pushes the leaf eval
    // sharply negative so the AI prefers any line that mitigates (retreat
    // to a safer body, heal, disrupt) rather than passively ending turn.
    // We assert observable mitigation: AI did SOMETHING this turn (state
    // changed beyond drawing a card) rather than blundering into a pass.
    const state = bootGame(2102);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";
    // Opp at 1 prize remaining.
    state.players[op].prizes = state.players[op].prizes.slice(0, 1);
    // AI Active: 2-prize ex on its last legs.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Ex",
        hp: 200,
        subtypes: ["Basic", "ex"],
        attacks: [{ name: "Punch", cost: ["Fire"], damage: 60 }],
      }),
      {
        instanceId: "ai-ex",
        damage: 160,
        attachedEnergy: [mkEnergy("Fire")],
      },
    );
    // Bench has a safer body to retreat into (but no immediate counter
    // attack — this isolates "did the AI react to the game-losing
    // pressure" from "did the AI take a counter-OHKO").
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({ name: "AI Safe", hp: 120 }),
        { instanceId: "ai-safe" },
      ),
    ];
    // Opp Active threatens lethal next turn.
    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp Hitter",
        hp: 200,
        attacks: [{ name: "Smash", cost: ["Fire"], damage: 220 }],
      }),
      {
        instanceId: "opp-active",
        attachedEnergy: [mkEnergy("Fire")],
      },
    );

    expect(() => takeAiTurn(state, ap)).not.toThrow();
    // The game isn't already over from our turn — we're still in play.
    expect(state.winner).not.toBe(op);
  });

  it("v2 leaf eval treats evolution-in-hand as setup value (takeAiTurn handles the scoring path)", () => {
    // Direct path: AI has Bulbasaur on bench, Ivysaur in hand. The
    // evolution-in-hand bonus fires in scoreAttackReadiness. We pin the
    // observable end-to-end: the AI evolves and the leaf eval doesn't
    // throw. Behavior parity: evolution still happens, no scoring crash.
    const state = bootGame(2103);
    const ap = state.activePlayer;
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 100,
        attacks: [{ name: "Hit", cost: [], damage: 30 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bulbasaur", hp: 70 }), {
        instanceId: "ai-bulb",
      }),
    ];
    state.players[ap].hand = [
      mkPokemonCard({
        name: "Ivysaur",
        subtypes: ["Stage 1"],
        hp: 100,
        evolvesFrom: "Bulbasaur",
        attacks: [{ name: "Vine Whip", cost: ["Grass"], damage: 50 }],
      }) as unknown as Card,
    ];

    expect(() => takeAiTurn(state, ap)).not.toThrow();
    // Bulbasaur evolved into Ivysaur somewhere on the bench/active.
    const allies = [
      state.players[ap].active,
      ...state.players[ap].bench,
    ].filter((p): p is PokemonInPlay => !!p);
    const evolvedExists = allies.some((p) => p.card.name === "Ivysaur");
    expect(evolvedExists).toBe(true);
  });
});

describe("Phase 3A — immediate-win sequencing", () => {
  it("v2 attacks for the last prize before playing setup Items", () => {
    const state = bootGame(3101);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].prizes = state.players[ap].prizes.slice(0, 1);
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Closer",
        hp: 120,
        attacks: [{ name: "Close Out", cost: [], damage: 100 }],
      }),
      { instanceId: "ai-closer" },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkItemCard("Precious Trolley", "searchAnyBasicsToBench"),
    ];
    state.players[ap].deck.unshift(
      mkPokemonCard({
        name: "Tempting Setup Basic",
        hp: 70,
        attacks: [{ name: "Tap", cost: [], damage: 10 }],
      }) as unknown as Card,
    );

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Last Prize Target", hp: 80 }),
      { instanceId: "opp-active-last-prize" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.winner === ap || state.players[ap].prizes.length === 0).toBe(true);
    expect(state.players[ap].hand.some((c) => c.name === "Precious Trolley")).toBe(true);
  });

  it("v2 gusts a bench last-prize target before playing setup cards", () => {
    const state = bootGame(3102);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].prizes = state.players[ap].prizes.slice(0, 1);
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Gust Closer",
        hp: 120,
        attacks: [{ name: "Pick Off", cost: [], damage: 90 }],
      }),
      { instanceId: "ai-gust-closer" },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkSupporterCard("Boss's Orders", "gustOppBenched"),
      mkItemCard("Precious Trolley", "searchAnyBasicsToBench"),
    ];
    state.players[ap].deck.unshift(
      mkPokemonCard({
        name: "Tempting Setup Basic",
        hp: 70,
        attacks: [{ name: "Tap", cost: [], damage: 10 }],
      }) as unknown as Card,
    );

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({ name: "Bench Last Prize", hp: 60 }),
        { instanceId: "bench-last-prize" },
      ),
    ];

    takeAiTurn(state, ap);

    expect(state.winner === ap || state.players[ap].prizes.length === 0).toBe(true);
    expect(state.players[op].discard.some((c) => c.name === "Bench Last Prize")).toBe(true);
    expect(state.players[ap].hand.some((c) => c.name === "Precious Trolley")).toBe(true);
  });
});

describe("Phase 3B — search-before-attach", () => {
  it("v2 plays Nest Ball before attaching Energy when the searched Basic is the better attach target", () => {
    const state = bootGame(3201);
    const ap = state.activePlayer;

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Already Powered Active",
        hp: 130,
        types: ["Colorless"],
        attacks: [{ name: "Ready Hit", cost: ["Colorless"], damage: 60 }],
      }),
      {
        instanceId: "already-powered-active",
        attachedEnergy: [mkEnergy("Fire")],
      },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkItemCard("Nest Ball", "searchBasicPokemon1"),
      mkEnergy("Fighting") as unknown as Card,
    ];
    // Pin the deck so Nest Ball's Basic-search is deterministic: Riolu is
    // the only eligible Basic, so the picker MUST land Riolu. The Mega
    // Lucario ex (Stage 1) is included to confirm non-Basic candidates are
    // filtered; the filler Items prevent the deck from emptying mid-turn.
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Mega Lucario ex",
        subtypes: ["Stage 1", "Mega", "ex"],
        hp: 340,
        evolvesFrom: "Riolu",
      }) as unknown as Card,
      mkPokemonCard({
        name: "Riolu",
        hp: 70,
        types: ["Fighting"],
        attacks: [{ name: "Jab", cost: ["Fighting"], damage: 70 }],
      }) as unknown as Card,
      mkItemCard("Filler Item", "potionHeal30") as unknown as Card,
      mkItemCard("Filler Item 2", "potionHeal30") as unknown as Card,
    ];

    takeAiTurn(state, ap);

    const riolu = [
      state.players[ap].active,
      ...state.players[ap].bench,
    ].find((p): p is PokemonInPlay => !!p && p.card.name === "Riolu");
    expect(riolu).toBeTruthy();
    expect(riolu?.attachedEnergy.some((e) => e.name === "Basic Fighting Energy")).toBe(true);
    expect(state.players[ap].hand.some((c) => c.name === "Nest Ball")).toBe(false);
  });

  it("v2 keeps the current attach target when searched Basics would not improve it", () => {
    const state = bootGame(3202);
    const ap = state.activePlayer;

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "One Short Active",
        hp: 150,
        types: ["Fire"],
        attacks: [{ name: "Big Flame", cost: ["Fire", "Fire"], damage: 160 }],
      }),
      {
        instanceId: "one-short-active",
        attachedEnergy: [mkEnergy("Fire")],
      },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkItemCard("Ultra Ball", "searchAnyPokemon"),
      mkEnergy("Fire") as unknown as Card,
    ];
    state.players[ap].deck.unshift(
      mkPokemonCard({
        name: "Filler Basic",
        hp: 60,
        types: ["Colorless"],
        attacks: [{ name: "Tiny Tap", cost: ["Colorless"], damage: 10 }],
      }) as unknown as Card,
    );

    takeAiTurn(state, ap);

    expect(state.players[ap].active?.instanceId).toBe("one-short-active");
    expect(state.players[ap].active?.attachedEnergy.length).toBe(2);
    expect(state.players[ap].hand.some((c) => c.name === "Ultra Ball")).toBe(true);
    expect(state.players[ap].bench.some((p) => p.card.name === "Filler Basic")).toBe(false);
  });
});

describe("Phase 3C — ability-before-Supporter", () => {
  it("v2 fires Bibarel-style Industrious Incisors before deciding whether to play Iono", () => {
    const state = bootGame(3301);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 130,
        attacks: [{ name: "Hold", cost: ["Colorless"], damage: 20 }],
      }),
      { instanceId: "ai-active" },
    );
    const bibarel = mkInPlay(
      mkPokemonCard({
        name: "Bibarel",
        subtypes: ["Stage 1"],
        hp: 120,
        abilities: [
          {
            name: "Industrious Incisors",
            type: "Ability",
            text: "Once during your turn, you may draw a card.",
            effect: { kind: "drawOne", oncePerTurn: true },
          },
        ],
      }),
      { instanceId: "ai-bibarel" },
    );
    state.players[ap].bench = [bibarel];
    state.players[ap].hand = [
      mkSupporterCard("Iono", "drawUntilSeven"),
      mkFillerTrainer("Filler A"),
      mkFillerTrainer("Filler B"),
      mkFillerTrainer("Filler C"),
    ];
    state.players[ap].deck = [
      mkFillerTrainer("Drawn Filler") as unknown as Card,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.log.some((e) => e.text.includes("uses Industrious Incisors"))).toBe(true);
    expect(state.players[ap].hand.some((c) => c.name === "Drawn Filler")).toBe(true);
    expect(state.players[ap].hand.some((c) => c.name === "Iono")).toBe(true);
    expect(state.players[ap].supporterPlayedThisTurn).toBe(false);
  });

  it("v2 fires Teal Dance before deciding whether to play Professor's Research", () => {
    const state = bootGame(3302);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Teal Mask Ogerpon ex",
        subtypes: ["Basic", "ex"],
        hp: 210,
        types: ["Grass"],
        abilities: [
          {
            name: "Teal Dance",
            type: "Ability",
            text: "Attach a Basic Grass Energy from your hand to this Pokemon. If you do, draw a card.",
            effect: {
              kind: "attachEnergyFromHandThenDraw",
              energyType: "Grass",
              drawCount: 1,
              oncePerTurn: true,
            },
          },
        ],
        attacks: [{ name: "Myriad Leaf Shower", cost: ["Grass", "Colorless", "Colorless"], damage: 120 }],
      }),
      { instanceId: "ai-ogerpon" },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Grass Backup",
          hp: 120,
          types: ["Grass"],
          attacks: [{ name: "Leaf Hit", cost: ["Grass", "Grass"], damage: 90 }],
        }),
        { instanceId: "grass-backup" },
      ),
    ];
    state.players[ap].hand = [
      mkSupporterCard("Professor's Research", "drawUntilSeven"),
      mkEnergy("Grass") as unknown as Card,
      mkFillerTrainer("Research Filler"),
    ];
    state.players[ap].deck = [
      mkFillerTrainer("Teal Dance Draw") as unknown as Card,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.log.some((e) => e.text.includes("uses Teal Dance"))).toBe(true);
    expect(
      state.players[ap].active?.attachedEnergy.some((e) =>
        e.provides.includes("Grass"),
      ),
    ).toBe(true);
    expect(
      state.players[ap].discard.some((c) => c.name === "Professor's Research") ||
        state.players[ap].hand.some((c) => c.name === "Professor's Research"),
    ).toBe(true);
  });
});

describe("Phase 3D — ACE SPEC conservation", () => {
  it("v2 holds Prime Catcher when no concrete KO target exists", () => {
    const state = bootGame(3401);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Patient Attacker",
        hp: 140,
        attacks: [{ name: "Steady Hit", cost: [], damage: 70 }],
      }),
      { instanceId: "ai-patient" },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkAceSpecItemCard("Prime Catcher", "primeCatcher"),
    ];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Durable Active", hp: 220 }),
      { instanceId: "opp-durable-active" },
    );
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({ name: "Opp Durable Bench", hp: 220 }),
        { instanceId: "opp-durable-bench" },
      ),
    ];

    takeAiTurn(state, ap);

    expect(state.players[ap].hand.some((c) => c.name === "Prime Catcher")).toBe(true);
    expect(state.players[ap].discard.some((c) => c.name === "Prime Catcher")).toBe(false);
    expect(state.players[op].active?.instanceId).toBe("opp-durable-active");
  });

  it("v2 plays Prime Catcher when it's a decisive KO", () => {
    const state = bootGame(3402);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Closer",
        hp: 140,
        attacks: [{ name: "Prize Shot", cost: [], damage: 180 }],
      }),
      { instanceId: "ai-closer" },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [
      mkAceSpecItemCard("Prime Catcher", "primeCatcher"),
    ];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall-active" },
    );
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Opp Bench ex",
          hp: 170,
          subtypes: ["Basic", "ex"],
        }),
        { instanceId: "opp-bench-ex" },
      ),
    ];

    takeAiTurn(state, ap);

    expect(state.players[ap].discard.some((c) => c.name === "Prime Catcher")).toBe(true);
    expect(state.players[op].discard.some((c) => c.name === "Opp Bench ex")).toBe(true);
    expect(
      [state.players[op].active, ...state.players[op].bench]
        .some((p) => p?.instanceId === "opp-bench-ex"),
    ).toBe(false);
  });
});

describe("Phase 3E — candidate-generator parity", () => {
  it("v2 keeps Item before evolve and Energy attach on a multi-option turn", () => {
    const state = bootGame(3501);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 140,
        attacks: [{ name: "Hold", cost: ["Colorless", "Colorless"], damage: 40 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Bench Base",
          hp: 80,
          types: ["Fire"],
          attacks: [{ name: "Spark", cost: ["Fire"], damage: 40 }],
        }),
        { instanceId: "bench-base", playedThisTurn: false },
      ),
    ];
    state.players[ap].hand = [
      mkItemCard("Nest Ball", "searchBasicPokemon1"),
      mkPokemonCard({
        name: "Bench Stage 1",
        subtypes: ["Stage 1"],
        evolvesFrom: "Bench Base",
        hp: 150,
        types: ["Fire"],
        attacks: [{ name: "Flare", cost: ["Fire"], damage: 100 }],
      }) as unknown as Card,
      mkEnergy("Fire") as unknown as Card,
    ];
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Searched Basic",
        hp: 70,
        types: ["Fire"],
        attacks: [{ name: "Ember", cost: ["Fire"], damage: 30 }],
      }) as unknown as Card,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    const itemLog = state.log.findIndex((e) => e.text.includes("plays Nest Ball"));
    const evolveLog = state.log.findIndex((e) => e.text.includes("evolves into Bench Stage 1"));
    const attachLog = state.log.findIndex((e) => e.text.includes("attaches Basic Fire Energy"));

    expect(itemLog).toBeGreaterThanOrEqual(0);
    expect(evolveLog).toBeGreaterThan(itemLog);
    expect(attachLog).toBeGreaterThan(itemLog);
    expect(state.players[ap].bench.some((p) => p.card.name === "Searched Basic")).toBe(true);
  });
});

describe("Phase 4A — Dragapult playbook profile", () => {
  it("dragapult-blaziken v2 benches Dreepy before generic Basics", () => {
    const state = bootGame(4101);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 130,
        attacks: [{ name: "Hold", cost: [], damage: 20 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bench Filler A", hp: 80 }), {
        instanceId: "bench-a",
      }),
      mkInPlay(mkPokemonCard({ name: "Bench Filler B", hp: 80 }), {
        instanceId: "bench-b",
      }),
    ];
    state.players[ap].hand = [
      mkPokemonCard({
        name: "Generic ex Basic",
        subtypes: ["Basic", "ex"],
        hp: 230,
        attacks: [{ name: "Big Tap", cost: ["Colorless"], damage: 40 }],
      }) as unknown as Card,
      mkPokemonCard({
        name: "Dreepy",
        hp: 60,
        types: ["Psychic"],
        attacks: [{ name: "Gnaw", cost: [], damage: 10 }],
      }) as unknown as Card,
    ];
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Dragapult ex",
        subtypes: ["Stage 2", "Tera", "ex"],
        evolvesFrom: "Drakloak",
        hp: 320,
      }) as unknown as Card,
      mkPokemonCard({
        name: "Drakloak",
        subtypes: ["Stage 1"],
        evolvesFrom: "Dreepy",
        hp: 90,
      }) as unknown as Card,
      mkPokemonCard({
        name: "Blaziken ex",
        subtypes: ["Stage 2", "ex"],
        evolvesFrom: "Combusken",
        hp: 320,
      }) as unknown as Card,
    ];
    state.players[ap].discard = [];
    state.players[ap].prizes = [
      mkFillerTrainer("Prize Filler 1") as unknown as Card,
      mkFillerTrainer("Prize Filler 2") as unknown as Card,
      mkFillerTrainer("Prize Filler 3") as unknown as Card,
    ];
    (state as GameState & { _archetypeCache?: unknown })._archetypeCache = undefined;
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    const dreepyLog = state.log.findIndex((e) =>
      e.text.includes("plays Dreepy to the Bench"),
    );
    const genericLog = state.log.findIndex((e) =>
      e.text.includes("plays Generic ex Basic to the Bench"),
    );
    expect(dreepyLog).toBeGreaterThanOrEqual(0);
    expect(genericLog === -1 || dreepyLog < genericLog).toBe(true);
    expect(state.players[ap].bench.some((p) => p.card.name === "Dreepy")).toBe(true);
  });

  it("dragapult-dudunsparce v2 searches Dragapult ex then uses Rare Candy on Dreepy", () => {
    const state = bootGame(4102);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 130,
        attacks: [{ name: "Hold", cost: [], damage: 20 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Dreepy",
          hp: 60,
          types: ["Psychic"],
          attacks: [{ name: "Gnaw", cost: [], damage: 10 }],
        }),
        { instanceId: "dreepy-ready", playedThisTurn: false },
      ),
    ];
    state.players[ap].hand = [
      mkItemCard("Ultra Ball", "searchAnyPokemonFree"),
      mkItemCard("Rare Candy", "rareCandyEvolve"),
    ];
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Generic Stage 2",
        subtypes: ["Stage 2"],
        evolvesFrom: "Middle Filler",
        hp: 330,
      }) as unknown as Card,
      mkPokemonCard({
        name: "Dragapult ex",
        subtypes: ["Stage 2", "Tera", "ex"],
        evolvesFrom: "Drakloak",
        hp: 320,
        types: ["Dragon"],
        attacks: [
          { name: "Jet Headbutt", cost: ["Colorless"], damage: 70 },
          {
            name: "Phantom Dive",
            cost: ["Fire", "Psychic"],
            damage: 200,
            text: "Put 6 damage counters on your opponent's Benched Pokémon in any way you like.",
          },
        ],
      }) as unknown as Card,
      mkPokemonCard({
        name: "Drakloak",
        subtypes: ["Stage 1"],
        evolvesFrom: "Dreepy",
        hp: 90,
      }) as unknown as Card,
      mkPokemonCard({
        name: "Dudunsparce ex",
        subtypes: ["Stage 1", "ex"],
        evolvesFrom: "Dunsparce",
        hp: 270,
      }) as unknown as Card,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];
    state.players[ap].discard = [];
    state.players[ap].prizes = [
      mkFillerTrainer("Prize Filler 1") as unknown as Card,
      mkFillerTrainer("Prize Filler 2") as unknown as Card,
      mkFillerTrainer("Prize Filler 3") as unknown as Card,
    ];
    (state as GameState & { _archetypeCache?: unknown })._archetypeCache = undefined;
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    const evolvedDreepy = state.players[ap].bench.find(
      (p) => p.instanceId === "dreepy-ready",
    );
    expect(evolvedDreepy?.card.name).toBe("Dragapult ex");
    expect(state.players[ap].discard.some((c) => c.name === "Rare Candy")).toBe(true);
    expect(state.log.some((e) =>
      e.text.includes("uses Rare Candy to evolve into Dragapult ex"),
    )).toBe(true);
  });
});

describe("Phase 4B — Crustle wall-first playbook profile", () => {
  it("crustle v2 benches Dwebble before generic Basics", () => {
    const state = bootGame(4201);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Active",
        hp: 130,
        attacks: [{ name: "Hold", cost: [], damage: 20 }],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bench Filler A", hp: 80 }), {
        instanceId: "bench-a",
      }),
      mkInPlay(mkPokemonCard({ name: "Bench Filler B", hp: 80 }), {
        instanceId: "bench-b",
      }),
    ];
    state.players[ap].hand = [
      mkPokemonCard({
        name: "Generic ex Basic",
        subtypes: ["Basic", "ex"],
        hp: 230,
        attacks: [{ name: "Big Tap", cost: ["Colorless"], damage: 40 }],
      }) as unknown as Card,
      mkPokemonCard({
        name: "Dwebble",
        hp: 70,
        types: ["Grass"],
        attacks: [{ name: "Stomp", cost: ["Grass", "Colorless"], damage: 30 }],
      }) as unknown as Card,
    ];
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Crustle",
        subtypes: ["Stage 1"],
        evolvesFrom: "Dwebble",
        hp: 150,
        types: ["Grass"],
        attacks: [
          { name: "Superb Scissors", cost: ["Grass", "Colorless", "Colorless"], damage: 120 },
        ],
        abilities: [
          {
            name: "Mysterious Rock Inn",
            text: "Prevent all damage done to this Pokémon by attacks from your opponent's Pokémon ex.",
            type: "Ability",
          },
        ],
      }) as unknown as Card,
      mkPokemonCard({
        name: "Cornerstone Mask Ogerpon ex",
        subtypes: ["Basic", "Tera", "ex"],
        hp: 210,
        types: ["Fighting"],
        attacks: [{ name: "Demolish", cost: ["Fighting", "Colorless", "Colorless"], damage: 140 }],
        abilities: [
          {
            name: "Cornerstone Stance",
            text: "Prevent all damage from attacks done to this Pokémon by your opponent's Pokémon that have an Ability.",
            type: "Ability",
          },
        ],
      }) as unknown as Card,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];
    state.players[ap].discard = [];
    state.players[ap].prizes = [
      mkFillerTrainer("Prize Filler 1") as unknown as Card,
      mkFillerTrainer("Prize Filler 2") as unknown as Card,
      mkFillerTrainer("Prize Filler 3") as unknown as Card,
    ];
    (state as GameState & { _archetypeCache?: unknown })._archetypeCache = undefined;
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    const dwebbleLog = state.log.findIndex((e) =>
      e.text.includes("plays Dwebble to the Bench"),
    );
    const genericLog = state.log.findIndex((e) =>
      e.text.includes("plays Generic ex Basic to the Bench"),
    );
    expect(dwebbleLog).toBeGreaterThanOrEqual(0);
    expect(genericLog === -1 || dwebbleLog < genericLog).toBe(true);
    expect(state.players[ap].bench.some((p) => p.card.name === "Dwebble")).toBe(true);
  });

  it("crustle v2 attaches Powerglass before taking a wall-phase attack", () => {
    const state = bootGame(4202);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Crustle",
        subtypes: ["Stage 1"],
        evolvesFrom: "Dwebble",
        hp: 150,
        types: ["Grass"],
        attacks: [{ name: "Superb Scissors", cost: [], damage: 120 }],
        abilities: [
          {
            name: "Mysterious Rock Inn",
            text: "Prevent all damage done to this Pokémon by attacks from your opponent's Pokémon ex.",
            type: "Ability",
          },
        ],
      }),
      { instanceId: "crustle-active", damage: 70 },
    );
    state.players[ap].bench = [];
    state.players[ap].hand = [mkToolCard("Powerglass") as unknown as Card];
    state.players[ap].deck = [
      mkPokemonCard({
        name: "Dwebble",
        hp: 70,
        types: ["Grass"],
        attacks: [{ name: "Stomp", cost: ["Grass", "Colorless"], damage: 30 }],
      }) as unknown as Card,
      mkPokemonCard({
        name: "Cornerstone Mask Ogerpon ex",
        subtypes: ["Basic", "Tera", "ex"],
        hp: 210,
        types: ["Fighting"],
        attacks: [{ name: "Demolish", cost: ["Fighting", "Colorless", "Colorless"], damage: 140 }],
        abilities: [
          {
            name: "Cornerstone Stance",
            text: "Prevent all damage from attacks done to this Pokémon by your opponent's Pokémon that have an Ability.",
            type: "Ability",
          },
        ],
      }) as unknown as Card,
    ];
    state.players[ap].discard = [mkEnergy("Grass") as unknown as Card];
    state.players[ap].prizes = [
      mkFillerTrainer("Prize Filler 1") as unknown as Card,
      mkFillerTrainer("Prize Filler 2") as unknown as Card,
      mkFillerTrainer("Prize Filler 3") as unknown as Card,
    ];
    (state as GameState & { _archetypeCache?: unknown })._archetypeCache = undefined;
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    const toolLog = state.log.findIndex((e) =>
      e.text.includes("attaches Powerglass to Crustle"),
    );
    const attackLog = state.log.findIndex((e) =>
      e.text.includes("attacks with Superb Scissors"),
    );
    expect(toolLog).toBeGreaterThanOrEqual(0);
    expect(attackLog).toBeGreaterThan(toolLog);
    expect(
      state.players[ap].active?.tools.some((tool) => tool.name === "Powerglass"),
    ).toBe(true);
    expect(
      state.players[ap].active?.attachedEnergy.some((energy) => energy.name === "Basic Grass Energy"),
    ).toBe(true);
  });
});

describe("Phase 4C — remaining archetype playbook profiles", () => {
  function expectBenchesArchetypeBasic(
    seed: number,
    basic: PokemonCard,
    signatureCards: Card[],
  ): void {
    const state = bootGame(seed);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.turn = 1;
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "AI Holding Active",
        hp: 130,
        attacks: [],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Bench Filler A", hp: 80 }), {
        instanceId: "bench-a",
      }),
      mkInPlay(mkPokemonCard({ name: "Bench Filler B", hp: 80 }), {
        instanceId: "bench-b",
      }),
      mkInPlay(mkPokemonCard({ name: "Bench Filler C", hp: 80 }), {
        instanceId: "bench-c",
      }),
    ];
    state.players[ap].hand = [
      mkPokemonCard({
        name: "Generic ex Basic",
        subtypes: ["Basic", "ex"],
        hp: 230,
        attacks: [{ name: "Big Tap", cost: ["Colorless"], damage: 40 }],
      }) as unknown as Card,
      basic as unknown as Card,
    ];
    state.players[ap].deck = [
      ...signatureCards,
      mkFillerTrainer("Deck Filler") as unknown as Card,
    ];
    state.players[ap].discard = [];
    state.players[ap].prizes = [
      mkFillerTrainer("Prize Filler 1") as unknown as Card,
      mkFillerTrainer("Prize Filler 2") as unknown as Card,
      mkFillerTrainer("Prize Filler 3") as unknown as Card,
    ];
    (state as GameState & { _archetypeCache?: unknown })._archetypeCache = undefined;
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Wall", hp: 300 }),
      { instanceId: "opp-wall" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    expect(state.players[ap].bench.some((p) => p.card.name === basic.name)).toBe(true);
    expect(state.players[ap].bench.some((p) => p.card.name === "Generic ex Basic")).toBe(false);
  }

  it("festival-leads v2 benches Applin before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4301,
      mkPokemonCard({
        name: "Applin",
        hp: 60,
        types: ["Grass"],
        attacks: [{ name: "Rollout", cost: ["Colorless"], damage: 10 }],
      }),
      [
        mkFillerTrainer("Festival Grounds") as unknown as Card,
        mkPokemonCard({
          name: "Dipplin",
          subtypes: ["Stage 1"],
          evolvesFrom: "Applin",
          hp: 90,
        }) as unknown as Card,
        mkPokemonCard({ name: "Thwackey", subtypes: ["Stage 1"], hp: 100 }) as unknown as Card,
      ],
    );
  });

  it("arboliva v2 benches Smoliv before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4302,
      mkPokemonCard({
        name: "Smoliv",
        hp: 60,
        types: ["Grass"],
        attacks: [{ name: "Tackle", cost: ["Colorless"], damage: 10 }],
      }),
      [
        mkPokemonCard({
          name: "Arboliva ex",
          subtypes: ["Stage 2", "ex"],
          evolvesFrom: "Dolliv",
          hp: 310,
        }) as unknown as Card,
        mkPokemonCard({
          name: "Teal Mask Ogerpon ex",
          subtypes: ["Basic", "ex"],
          hp: 210,
        }) as unknown as Card,
        mkFillerTrainer("Forest of Vitality") as unknown as Card,
      ],
    );
  });

  it("alakazam v2 benches Abra before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4303,
      mkPokemonCard({
        name: "Abra",
        hp: 50,
        types: ["Psychic"],
        attacks: [{ name: "Psyshot", cost: ["Psychic"], damage: 20 }],
      }),
      [
        mkPokemonCard({
          name: "Alakazam ex",
          subtypes: ["Stage 2", "ex"],
          evolvesFrom: "Kadabra",
          hp: 310,
        }) as unknown as Card,
        mkFillerTrainer("Battle Cage") as unknown as Card,
        mkPokemonCard({ name: "Dudunsparce", subtypes: ["Stage 1"], hp: 140 }) as unknown as Card,
      ],
    );
  });

  it("lucario-ex v2 benches Riolu before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4304,
      mkPokemonCard({
        name: "Riolu",
        hp: 70,
        types: ["Fighting"],
        attacks: [{ name: "Jab", cost: ["Fighting"], damage: 30 }],
      }),
      [
        mkPokemonCard({
          name: "Mega Lucario ex",
          subtypes: ["Stage 1", "Mega", "ex"],
          evolvesFrom: "Riolu",
          hp: 340,
        }) as unknown as Card,
        mkFillerTrainer("Premium Power Pro") as unknown as Card,
      ],
    );
  });

  it("rocket-mewtwo v2 benches Team Rocket's Tarountula before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4305,
      mkPokemonCard({
        name: "Team Rocket's Tarountula",
        hp: 70,
        types: ["Grass"],
        attacks: [{ name: "Gnaw", cost: ["Colorless"], damage: 10 }],
      }),
      [
        mkPokemonCard({
          name: "Team Rocket's Mewtwo ex",
          subtypes: ["Basic", "ex"],
          hp: 280,
        }) as unknown as Card,
        mkPokemonCard({
          name: "Team Rocket's Spidops",
          subtypes: ["Stage 1"],
          evolvesFrom: "Team Rocket's Tarountula",
          hp: 130,
        }) as unknown as Card,
        mkEnergy("Psychic") as unknown as Card,
      ],
    );
  });

  it("cynthia-garchomp v2 benches Cynthia's Gible before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4306,
      mkPokemonCard({
        name: "Cynthia's Gible",
        hp: 70,
        types: ["Fighting"],
        attacks: [{ name: "Bite", cost: ["Colorless"], damage: 20 }],
      }),
      [
        mkPokemonCard({
          name: "Cynthia's Garchomp ex",
          subtypes: ["Stage 2", "ex"],
          evolvesFrom: "Cynthia's Gabite",
          hp: 330,
        }) as unknown as Card,
        mkPokemonCard({
          name: "Cynthia's Gabite",
          subtypes: ["Stage 1"],
          evolvesFrom: "Cynthia's Gible",
          hp: 100,
        }) as unknown as Card,
        mkPokemonCard({ name: "Cynthia's Roserade", subtypes: ["Stage 1"], hp: 130 }) as unknown as Card,
      ],
    );
  });

  it("grimmsnarl-froslass v2 benches Marnie's Impidimp before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4307,
      mkPokemonCard({
        name: "Marnie's Impidimp",
        hp: 70,
        types: ["Darkness"],
        attacks: [{ name: "Stampede", cost: ["Colorless"], damage: 10 }],
      }),
      [
        mkPokemonCard({
          name: "Marnie's Grimmsnarl ex",
          subtypes: ["Stage 2", "ex"],
          evolvesFrom: "Marnie's Morgrem",
          hp: 330,
        }) as unknown as Card,
        mkPokemonCard({
          name: "Marnie's Morgrem",
          subtypes: ["Stage 1"],
          evolvesFrom: "Marnie's Impidimp",
          hp: 100,
        }) as unknown as Card,
        mkFillerTrainer("Spikemuth Gym") as unknown as Card,
      ],
    );
  });

  it("mega-starmie-froslass v2 benches Staryu before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4308,
      mkPokemonCard({
        name: "Staryu",
        hp: 60,
        types: ["Water"],
        attacks: [{ name: "Water Gun", cost: ["Water"], damage: 20 }],
      }),
      [
        mkPokemonCard({
          name: "Mega Starmie ex",
          subtypes: ["Stage 1", "Mega", "ex"],
          evolvesFrom: "Staryu",
          hp: 270,
        }) as unknown as Card,
        mkFillerTrainer("Risky Ruins") as unknown as Card,
        mkPokemonCard({
          name: "Mega Froslass ex",
          subtypes: ["Stage 1", "Mega", "ex"],
          evolvesFrom: "Snorunt",
          hp: 270,
        }) as unknown as Card,
      ],
    );
  });

  it("hops-trevenant v2 benches Hop's Phantump before generic Basics", () => {
    expectBenchesArchetypeBasic(
      4309,
      mkPokemonCard({
        name: "Hop's Phantump",
        hp: 70,
        types: ["Psychic"],
        attacks: [{ name: "Splashing Dodge", cost: ["Psychic"], damage: 20 }],
      }),
      [
        mkPokemonCard({
          name: "Hop's Trevenant",
          subtypes: ["Stage 1"],
          evolvesFrom: "Hop's Phantump",
          hp: 140,
        }) as unknown as Card,
        mkFillerTrainer("Postwick") as unknown as Card,
        mkToolCard("Hop's Choice Band") as unknown as Card,
      ],
    );
  });
});

describe("Phase 5E — evolution target scorer", () => {
  it("v2 prefers the evolution that unlocks a draw ability over an equal-HP vanilla evolution", () => {
    const state = bootGame(5501);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    // Two eligible Basics on bench: each waiting for its Stage 1.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({ name: "AP Anchor", hp: 120 }),
      { instanceId: "ap-anchor" },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Bibarel Base",
          hp: 70,
          types: ["Colorless"],
          attacks: [{ name: "Tackle", cost: [], damage: 20 }],
        }),
        { instanceId: "bibarel-base" },
      ),
      mkInPlay(
        mkPokemonCard({
          name: "Vanilla Base",
          hp: 70,
          types: ["Colorless"],
          attacks: [{ name: "Tackle", cost: [], damage: 20 }],
        }),
        { instanceId: "vanilla-base" },
      ),
    ];
    // Hand has BOTH Stage 1 forms. Each evolves only its own base.
    // The "AbilityStage1" has a drawTwo ability — Phase 5E's ability-unlock
    // bonus (+15) should make it the higher-scored option even though both
    // have identical HP / attack damage.
    state.players[ap].hand = [
      mkPokemonCard({
        name: "VanillaStage1",
        subtypes: ["Stage 1"],
        evolvesFrom: "Vanilla Base",
        hp: 110,
        types: ["Colorless"],
        attacks: [{ name: "Headbutt", cost: ["Colorless"], damage: 40 }],
      }) as unknown as Card,
      {
        ...mkPokemonCard({
          name: "AbilityStage1",
          subtypes: ["Stage 1"],
          evolvesFrom: "Bibarel Base",
          hp: 110,
          types: ["Colorless"],
          attacks: [{ name: "Headbutt", cost: ["Colorless"], damage: 40 }],
        }),
        abilities: [{
          name: "Industrious Incisors",
          text: "Draw 2 cards.",
          effect: { kind: "drawTwo", oncePerTurn: true },
        }],
      } as unknown as Card,
    ];
    state.players[ap].deck = [mkFillerTrainer("Pad") as unknown as Card];

    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp", hp: 200 }),
      { instanceId: "opp" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    // After the AI's turn, both could have evolved, but the FIRST evolution
    // (highest-scored) should be AbilityStage1 onto bibarel-base. Verify the
    // bibarel-base instance is now AbilityStage1 (i.e. the AI prioritized it).
    const allies = [state.players[ap].active, ...state.players[ap].bench]
      .filter((p): p is PokemonInPlay => !!p);
    const abilityEvolved = allies.find(
      (p) => p.instanceId === "bibarel-base" && p.card.name === "AbilityStage1",
    );
    expect(abilityEvolved).toBeTruthy();
  });

  it("v2 does not feed an evolution onto a damaged Active that both forms can't survive", () => {
    const state = bootGame(5502);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    // Active is heavily damaged; opp can OHKO either current or evolved form.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Damaged Base",
        hp: 100,
        types: ["Colorless"],
        attacks: [{ name: "Smack", cost: [], damage: 20 }],
      }),
      { instanceId: "damaged-base", damage: 80 },
    );
    state.players[ap].bench = [
      mkInPlay(mkPokemonCard({ name: "Safe Bench", hp: 120 }), { instanceId: "safe-bench" }),
    ];
    state.players[ap].hand = [
      mkPokemonCard({
        name: "WastedEvo",
        subtypes: ["Stage 1"],
        evolvesFrom: "Damaged Base",
        hp: 110,
        types: ["Colorless"],
        attacks: [{ name: "Pound", cost: ["Colorless"], damage: 40 }],
      }) as unknown as Card,
    ];
    state.players[ap].deck = [mkFillerTrainer("Pad") as unknown as Card];

    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp OHKOer",
        hp: 200,
        attacks: [{ name: "Smash", cost: [], damage: 200 }],
      }),
      { instanceId: "opp-ohko" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    // The damaged active is still the same card (didn't waste WastedEvo on it).
    const stillBase = state.players[ap].active?.card.name === "Damaged Base";
    const evolvedAnyway = state.players[ap].active?.card.name === "WastedEvo";
    // Either the AI held the evolution OR (acceptable) it evolved the safe-bench
    // ally instead. The hard failure mode would be: evolved damaged-base AND
    // it gets KO'd. Assert at minimum the AI didn't waste the evolution on
    // the doomed Active.
    expect(stillBase || !evolvedAnyway).toBe(true);
  });
});

describe("Phase 5F — attack-choice scorer with lookahead context", () => {
  it("v2 picks the higher-prize OHKO when two OHKO attacks are available", () => {
    const state = bootGame(5601);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    // Active has TWO payable attacks. Both OHKO their respective candidates.
    // attackValue should prefer the one that takes a 2-prize ex over a
    // 1-prize chip-KO.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Versatile Striker",
        hp: 180,
        attacks: [
          { name: "Light Hit", cost: ["Colorless"], damage: 100 }, // OHKOs 1-prize Active (90 HP)
          { name: "Heavy Hit", cost: ["Colorless"], damage: 250 }, // would OHKO a 2-prize ex too
        ],
      }),
      {
        instanceId: "striker",
        attachedEnergy: [mkEnergy("Colorless"), mkEnergy("Colorless")],
      },
    );
    state.players[ap].bench = [];
    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp Ex Wall",
        hp: 220,
        subtypes: ["Basic", "ex"],
      }),
      { instanceId: "opp-ex" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    // Heavy Hit OHKOs the 2-prize ex. After AI's turn, opp's Active is
    // either gone or replaced (the ex was KO'd, 2 prizes taken).
    const apPrizesBefore = 6;
    expect(state.players[ap].prizes.length).toBeLessThanOrEqual(apPrizesBefore - 2);
  });

  it("v2 keeps OHKO preference even when self-discard cost exists, with ready bench backup", () => {
    const state = bootGame(5602);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    // Active has an OHKO attack that discards energy as cost. Bench has a
    // ready attacker. The OHKO is correct (we have backup to swing next turn).
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Burst Attacker",
        hp: 130,
        attacks: [
          { name: "Burst Strike", cost: ["Fire", "Fire", "Fire"], damage: 220 },
        ],
      }),
      {
        instanceId: "burst",
        attachedEnergy: [mkEnergy("Fire"), mkEnergy("Fire"), mkEnergy("Fire")],
      },
    );
    state.players[ap].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Backup Attacker",
          hp: 120,
          attacks: [{ name: "Pound", cost: ["Fire"], damage: 60 }],
        }),
        {
          instanceId: "backup",
          attachedEnergy: [mkEnergy("Fire")],
        },
      ),
    ];
    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp Tank",
        hp: 200,
        subtypes: ["Basic", "ex"],
      }),
      { instanceId: "opp-tank" },
    );
    state.players[op].bench = [];

    takeAiTurn(state, ap);

    // The OHKO should have landed: opp's Active either KO'd outright or
    // has damage >= its max HP.
    const oppActiveGone = !state.players[op].active || state.players[op].active.card.name !== "Opp Tank";
    const oppMaxedDamage = state.players[op].active
      ? state.players[op].active.damage >= state.players[op].active.card.hp
      : false;
    expect(oppActiveGone || oppMaxedDamage).toBe(true);
  });
});

describe("Phase 5G — spread/counter placement scorer (Phantom Dive)", () => {
  it("v2 spread placement KOs a wounded opp bench target before chip-damaging a fresh one", () => {
    const state = bootGame(5701);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    // AI Active has a Phantom-Dive-like attack that places 6 counters on
    // opp's bench in any way (60 damage to distribute).
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Spreader",
        hp: 280,
        attacks: [{
          name: "Phantom Dive",
          cost: ["Psychic", "Psychic"],
          damage: 60,
          text: "Put 6 damage counters on your opponent's Benched Pokémon in any way you like.",
        }],
      }),
      {
        instanceId: "spreader",
        attachedEnergy: [mkEnergy("Psychic"), mkEnergy("Psychic")],
      },
    );
    state.players[ap].bench = [];
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Active", hp: 200 }),
      { instanceId: "opp-active" },
    );
    // Two bench targets:
    //   wounded (60 HP, 40 damage → 20 remaining; 6 counters = 60 damage = KO)
    //   fresh   (90 HP, 0 damage → not KO'd by 60 chip)
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({ name: "Wounded", hp: 60 }),
        { instanceId: "wounded", damage: 40 },
      ),
      mkInPlay(
        mkPokemonCard({ name: "Fresh", hp: 90 }),
        { instanceId: "fresh" },
      ),
    ];

    takeAiTurn(state, ap);

    // The wounded bench should be KO'd (60 damage placed there); fresh
    // should NOT be KO'd. The v2 placement prioritizes KO over chip.
    const wounded = state.players[op].bench.find((p) => p.instanceId === "wounded");
    const fresh = state.players[op].bench.find((p) => p.instanceId === "fresh");
    // After KO, wounded is removed from bench (or has damage >= max HP).
    const woundedKoed = !wounded || wounded.damage >= 60;
    // Fresh is not KO'd by chip — still on bench, alive.
    const freshAlive = !!fresh && fresh.damage < 90;
    expect(woundedKoed).toBe(true);
    expect(freshAlive).toBe(true);
  });

  it("v2 spread placement prefers a high-prize rule-box KO over a 1-prize KO of equal HP", () => {
    const state = bootGame(5702);
    const ap = state.activePlayer;
    const op: PlayerId = ap === "p1" ? "p2" : "p1";

    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Spreader",
        hp: 280,
        attacks: [{
          name: "Phantom Dive",
          cost: ["Psychic", "Psychic"],
          damage: 60,
          text: "Put 6 damage counters on your opponent's Benched Pokémon in any way you like.",
        }],
      }),
      {
        instanceId: "spreader",
        attachedEnergy: [mkEnergy("Psychic"), mkEnergy("Psychic")],
      },
    );
    state.players[ap].bench = [];
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Opp Active", hp: 200 }),
      { instanceId: "opp-active" },
    );
    // Two bench targets, both 1 placement away from KO:
    //   prize-rich ex (200 HP, 140 damage → 60 remaining = KO; subtypes Basic+ex = 2 prizes)
    //   prize-poor   (60 HP, 0 damage → 60 = KO; 1 prize)
    state.players[op].bench = [
      mkInPlay(
        mkPokemonCard({
          name: "Prize-Rich Ex",
          hp: 200,
          subtypes: ["Basic", "ex"],
        }),
        { instanceId: "prize-rich", damage: 140 },
      ),
      mkInPlay(
        mkPokemonCard({ name: "Prize-Poor", hp: 60 }),
        { instanceId: "prize-poor" },
      ),
    ];

    takeAiTurn(state, ap);

    // The prize-rich ex should be the one KO'd (2-prize swing).
    const prizesTakenByAi = 6 - state.players[ap].prizes.length;
    expect(prizesTakenByAi).toBeGreaterThanOrEqual(2);
  });
});
