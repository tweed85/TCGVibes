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
  it.fails(
    "does NOT play a dead-weight Basic to the bench while under spread pressure (xfail — over-benching protection not yet implemented)",
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
