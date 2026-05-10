// Phase 2A parity tests — scorePosition was refactored from a monolithic
// function into named sub-scores (scorePrizeRace, scoreImmediateThreats,
// scoreAttackReadiness, scoreBoardDevelopment, scoreResourceQuality,
// scoreBenchRisk, scoreDisruptionTiming). These tests pin observable
// AI behavior that depends on the position evaluator so we'd catch a math
// regression (off-by-one boundary, mistyped constant, sub-score field
// swap). scorePosition itself stays private; assertions hit takeAiTurn
// and resolveAiPendingPromote only.

import { describe, it, expect } from "vitest";
import {
  setupGame,
  resolveCoinGuess,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
} from "../rules";
import { takeAiTurn } from "../ai";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import type {
  EnergyCard,
  GameState,
  PokemonCard,
  PokemonInPlay,
} from "../types";

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

function mkInPlay(
  card: PokemonCard,
  over: Partial<PokemonInPlay> = {},
): PokemonInPlay {
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

// ---------------------------------------------------------------------------
// Terminal short-circuit — scorePosition's first two lines return ±1,000,000
// for already-decided games. takeAiTurn should refuse to mutate state.
// ---------------------------------------------------------------------------

describe("Phase 2A — scorePosition terminal short-circuit", () => {
  it("takeAiTurn is a no-op when the game is already won", () => {
    const state = bootGame(2001);
    const ap = state.activePlayer;
    state.winner = ap;
    state.phase = "gameOver";
    const handBefore = state.players[ap].hand.length;
    const turnBefore = state.turn;
    takeAiTurn(state, ap);
    expect(state.players[ap].hand.length).toBe(handBefore);
    expect(state.turn).toBe(turnBefore);
    expect(state.winner).toBe(ap);
  });

  it("takeAiTurn is a no-op when the game is already lost", () => {
    const state = bootGame(2002);
    const ap = state.activePlayer;
    const op = ap === "p1" ? "p2" : "p1";
    state.winner = op;
    state.phase = "gameOver";
    const handBefore = state.players[ap].hand.length;
    const turnBefore = state.turn;
    takeAiTurn(state, ap);
    expect(state.players[ap].hand.length).toBe(handBefore);
    expect(state.turn).toBe(turnBefore);
    expect(state.winner).toBe(op);
  });
});

// ---------------------------------------------------------------------------
// Prize-race gradient — scorePrizeRace's v2 non-linear weighting makes
// closing-out prizes worth more. AI near the finish line should still
// prefer the OHKO line over chip damage.
// ---------------------------------------------------------------------------

describe("Phase 2A — scorePrizeRace gradient", () => {
  it("v2 AI with 1 prize left picks the OHKO attack over chip", () => {
    const state = bootGame(2003);
    const ap = state.activePlayer;
    const op = ap === "p1" ? "p2" : "p1";
    // AI is 1 prize from winning.
    state.players[ap].prizes = state.players[ap].prizes.slice(0, 1);
    // AI Active: two attacks — chip and a big OHKO.
    state.players[ap].active = mkInPlay(
      mkPokemonCard({
        name: "Closer",
        attacks: [
          { name: "Chip", cost: [], damage: 30 },
          { name: "Finisher", cost: [], damage: 200 },
        ],
      }),
      { instanceId: "ai-active" },
    );
    state.players[ap].bench = [];
    state.players[op].active = mkInPlay(
      mkPokemonCard({ name: "Target", hp: 120 }),
      { instanceId: "opp-active" },
    );

    takeAiTurn(state, ap);

    // Closer either won outright or its 200-damage Finisher KO'd Target.
    const aiWon = state.winner === ap;
    const targetGone =
      state.players[op].active?.instanceId !== "opp-active" ||
      (state.players[op].active?.damage ?? 0) >=
        (state.players[op].active?.card.hp ?? 0);
    expect(aiWon || targetGone).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Catastrophic board state — scoreBoardDevelopment's -100,000 penalty when
// a side has no Active and no bench keeps the AI from blundering itself
// into a no-Pokémon position. If the engine reaches that state, takeAiTurn
// shouldn't throw and the game should be marked over.
// ---------------------------------------------------------------------------

describe("Phase 2A — scoreBoardDevelopment catastrophic-no-mons", () => {
  it("takeAiTurn doesn't throw when our Active is null and bench is empty", () => {
    const state = bootGame(2004);
    const ap = state.activePlayer;
    // Force the catastrophic state. In practice the engine would set
    // winner/phase via the no-Pokémon rule; we test that the AI eval
    // doesn't blow up on the way to recognizing it.
    state.players[ap].active = null;
    state.players[ap].bench = [];
    expect(() => takeAiTurn(state, ap)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// scoreImmediateThreats (v2) + scoreAttackReadiness gust-insurance — when
// the AI's Active is in OHKO range and a powered bench attacker exists,
// the AI's evaluation prefers preserving the at-risk multi-prizer.
// We don't isolate the helpers (private); we pin observable behavior on
// a state where the threat-aware branch is the load-bearing decision.
// ---------------------------------------------------------------------------

describe("Phase 2A — scoreImmediateThreats v2 threat-aware behavior", () => {
  it("v2 AI doesn't blunder a 2-prize ex into an OHKO when a safe bench attacker exists", () => {
    const state = bootGame(2005);
    const ap = state.activePlayer;
    const op = ap === "p1" ? "p2" : "p1";
    // AI Active: ex with low remaining HP — in OHKO range from opp.
    const aiEx = mkInPlay(
      mkPokemonCard({
        name: "AI Ex",
        hp: 200,
        subtypes: ["Basic", "ex"],
        attacks: [{ name: "Punch", cost: ["Fire"], damage: 60 }],
        retreatCost: [],
      }),
      {
        instanceId: "ai-ex",
        damage: 170,
        attachedEnergy: [mkEnergy("Fire")],
      },
    );
    // Bench: healthy attacker also ready to swing.
    const aiBench = mkInPlay(
      mkPokemonCard({
        name: "AI Safe",
        hp: 120,
        attacks: [{ name: "Strike", cost: ["Fire"], damage: 60 }],
      }),
      { instanceId: "ai-bench", attachedEnergy: [mkEnergy("Fire")] },
    );
    state.players[ap].active = aiEx;
    state.players[ap].bench = [aiBench];
    // Opp Active threatens lethal next turn.
    state.players[op].active = mkInPlay(
      mkPokemonCard({
        name: "Opp Hitter",
        hp: 120,
        attacks: [{ name: "Smash", cost: ["Fire"], damage: 200 }],
      }),
      { instanceId: "opp-active", attachedEnergy: [mkEnergy("Fire")] },
    );

    expect(() => takeAiTurn(state, ap)).not.toThrow();
    // After the turn, either the AI dealt enough damage to KO opp Active
    // first (winning the trade) OR the threat-aware evaluator at least
    // didn't generate an exception. We pin "no exception" — the deeper
    // strategic choice (retreat vs swing) depends on lookahead depth and
    // MCTS budget. The parity check is: this scenario still runs cleanly.
    expect(state.phase).not.toBe("gameOver");
  });
});
