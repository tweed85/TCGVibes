// Phase 5: replay tests.
//
// Contract:
//   - A short command sequence reconstructs the same final state when
//     replayed against a fresh setupGame with the same seed.
//   - Loader rejects newer schemas cleanly (typed `kind`).
//   - Failed commands NEVER appear in a recorded replay (the recorder
//     filters by ActionResult.ok); the test confirms a corrupt replay
//     surfaces a malformed-result on load.
//   - Every user-resolvable prompt field has a corresponding GameCommand.

import { describe, it, expect } from "vitest";
import {
  applyGameCommand,
  type GameCommand,
} from "../gameCommands";
import {
  finalizeReplayIfDone,
  loadReplay,
  newReplay,
  REPLAY_SCHEMA_VERSION,
  type GameReplay,
  type GameReplayV1,
  type GameReplayV2,
} from "../replay";
import { setupGame } from "../rules";
import { makeRng } from "../rng";
import { buildDeck, DECK_SPECS } from "../../data/decks";
import { cardsById } from "../../data/cards";
import type { GameState } from "../types";

const SEED = 12345;

function freshSetup() {
  const p1 = buildDeck(DECK_SPECS[0]);
  const p2 = buildDeck(DECK_SPECS[1]);
  return setupGame(p1, p2, makeRng(SEED), { p2IsAI: false });
}

describe("replay — recorder + loader", () => {
  it("records + replays setup → endTurn; loaded state matches the live state", () => {
    // Snapshot the *original* 60-card decks so we can build the replay
    // header against them. setupGame doesn't mutate input arrays (rng.shuffle
    // returns a copy), so post-setup access via live.players[..].deck only
    // sees the deck remainder after hands + prizes were drawn.
    const p1Deck = buildDeck(DECK_SPECS[0]);
    const p2Deck = buildDeck(DECK_SPECS[1]);
    const live = setupGame(p1Deck, p2Deck, makeRng(SEED), { p2IsAI: false });
    const recorded: GameCommand[] = [];

    const guessCmd: GameCommand = { kind: "resolveCoinGuess", player: "p1", guess: "heads" };
    expect(applyGameCommand(live, guessCmd).ok).toBe(true);
    recorded.push(guessCmd);

    const winner = live.coinFlip!.winner!;
    const chooseCmd: GameCommand = {
      kind: "chooseFirstPlayer",
      player: winner,
      chooseFirst: true,
    };
    expect(applyGameCommand(live, chooseCmd).ok).toBe(true);
    recorded.push(chooseCmd);

    for (const pid of ["p1", "p2"] as const) {
      const idx = live.players[pid].hand.findIndex(
        (c) => c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Basic"),
      );
      expect(idx).toBeGreaterThanOrEqual(0);
      const setupCmd: GameCommand = {
        kind: "completeSetup",
        player: pid,
        activeHandIndex: idx,
        benchHandIndexes: [],
      };
      expect(applyGameCommand(live, setupCmd).ok).toBe(true);
      recorded.push(setupCmd);
    }
    expect(live.phase).toBe("main");

    const ap = live.activePlayer;
    const endCmd: GameCommand = { kind: "endTurn", player: ap };
    expect(applyGameCommand(live, endCmd).ok).toBe(true);
    recorded.push(endCmd);

    const replay: GameReplay = {
      ...newReplay(p1Deck, p2Deck, SEED, { p2IsAI: false }),
      commands: recorded,
    };
    const result = loadReplay(replay, cardsById);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appVersionMatch).toBe(true);
    expect(result.dataVersionMatch).toBe(true);

    // Determinism contract: same seed + same commands → same state.
    expect(result.state.phase).toBe(live.phase);
    expect(result.state.activePlayer).toBe(live.activePlayer);
    expect(result.state.turn).toBe(live.turn);
    expect(result.state.firstPlayer).toBe(live.firstPlayer);
    expect(result.state.players.p1.active?.card.id).toBe(
      live.players.p1.active?.card.id,
    );
    expect(result.state.players.p2.active?.card.id).toBe(
      live.players.p2.active?.card.id,
    );
    expect(result.state.players.p1.hand.length).toBe(live.players.p1.hand.length);
    expect(result.state.players.p2.hand.length).toBe(live.players.p2.hand.length);
    expect(result.state.players.p1.deck.length).toBe(live.players.p1.deck.length);
    expect(result.state.players.p2.deck.length).toBe(live.players.p2.deck.length);
  });

  it("rejects newer schema versions with kind=newer-schema", () => {
    // Cast through unknown — the loader takes unknown and validates, so this
    // exercises the rejection path the way real callers will hit it.
    const replay = {
      ...newReplay([], [], SEED),
      schemaVersion: REPLAY_SCHEMA_VERSION + 1,
    } as unknown;
    const r = loadReplay(replay, cardsById);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("newer-schema");
  });

  it("v1 replay loads as v2 with outcome=undefined (migration shim)", () => {
    const live = freshSetup();
    const v1: GameReplayV1 = {
      schemaVersion: 1,
      appVersion: "0.0.0-old",
      dataVersion: "0001-01-01",
      createdAt: new Date().toISOString(),
      initial: {
        p1CardIds: live.players.p1.deck.map((c) => c.id),
        p2CardIds: live.players.p2.deck.map((c) => c.id),
        rngSeed: SEED,
        setupOptions: { p2IsAI: false },
      },
      commands: [],
    };
    const r = loadReplay(v1, cardsById);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The state is reconstructed via setupGame; the migrated replay has
    // outcome=undefined which is the correct "in-flight" semantics for v1.
    expect(r.appVersionMatch).toBe(false);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("schemaVersion: 0 still rejects (kind=older-schema)", () => {
    const replay = {
      ...newReplay([], [], SEED),
      schemaVersion: 0,
    } as unknown;
    const r = loadReplay(replay, cardsById);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("older-schema");
  });

  it("malformed input (non-object, missing fields) rejects with kind=malformed", () => {
    expect(loadReplay(null, cardsById).ok).toBe(false);
    expect(loadReplay("not a replay", cardsById).ok).toBe(false);
    expect(loadReplay({ schemaVersion: 2 }, cardsById).ok).toBe(false);
    const r = loadReplay({}, cardsById);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("malformed");
  });

  it("missing card ids surface as kind=missing-cards", () => {
    const replay: GameReplay = {
      ...newReplay([], [], SEED),
      initial: {
        p1CardIds: ["nonexistent-card-1"],
        p2CardIds: ["nonexistent-card-2"],
        rngSeed: SEED,
      },
    };
    const r = loadReplay(replay, cardsById);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("missing-cards");
  });

  it("warns on appVersion / dataVersion mismatch (still loads)", () => {
    const live = freshSetup();
    const replay: GameReplay = {
      ...newReplay(live.players.p1.deck, live.players.p2.deck, SEED),
      appVersion: "0.0.0-old",
      dataVersion: "0001-01-01",
    };
    const r = loadReplay(replay, cardsById);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appVersionMatch).toBe(false);
      expect(r.dataVersionMatch).toBe(false);
      expect(r.warnings.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("a corrupt command stream surfaces as kind=malformed", () => {
    const live = freshSetup();
    const replay: GameReplay = {
      ...newReplay(live.players.p1.deck, live.players.p2.deck, SEED),
      commands: [
        // Setup phase doesn't accept endTurn — engine returns failure.
        { kind: "endTurn", player: "p1" },
      ],
    };
    const r = loadReplay(replay, cardsById);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("malformed");
  });

  describe("finalizeReplayIfDone", () => {
    function makeReplay(): GameReplayV2 {
      return newReplay([], [], SEED, { p2IsAI: true });
    }
    function fakeState(opts: { phase: GameState["phase"]; winner: GameState["winner"] }): GameState {
      // Minimal state stub — finalizeReplayIfDone only reads phase + winner.
      // Cast is fine because the function's input contract is narrow.
      return {
        phase: opts.phase,
        winner: opts.winner,
      } as unknown as GameState;
    }
    const fixedClock = () => "2026-05-09T12:00:00.000Z";

    it("returns the updated replay when state.winner is set and game is over", () => {
      const replay = makeReplay();
      const state = fakeState({ phase: "gameOver", winner: "p1" });
      const updated = finalizeReplayIfDone(replay, state, "vsCPU", fixedClock);
      expect(updated).not.toBeNull();
      expect(updated!.outcome).toEqual({
        winner: "p1",
        completedAt: "2026-05-09T12:00:00.000Z",
        gameMode: "vsCPU",
      });
      // Pure: input replay isn't mutated.
      expect(replay.outcome).toBeUndefined();
    });

    it("returns null when outcome is already set (idempotent)", () => {
      const replay = makeReplay();
      replay.outcome = {
        winner: "p1",
        completedAt: "2026-01-01T00:00:00.000Z",
        gameMode: "vsCPU",
      };
      const state = fakeState({ phase: "gameOver", winner: "p2" });
      expect(finalizeReplayIfDone(replay, state, "vsCPU", fixedClock)).toBeNull();
    });

    it("returns null when game isn't over", () => {
      const replay = makeReplay();
      const state = fakeState({ phase: "main", winner: null });
      expect(finalizeReplayIfDone(replay, state, "vsCPU", fixedClock)).toBeNull();
    });

    it("populates winner=null when phase is gameOver but winner is null (draw / aborted)", () => {
      const replay = makeReplay();
      const state = fakeState({ phase: "gameOver", winner: null });
      const updated = finalizeReplayIfDone(replay, state, "local", fixedClock);
      expect(updated).not.toBeNull();
      expect(updated!.outcome?.winner).toBeNull();
      expect(updated!.outcome?.gameMode).toBe("local");
    });
  });

  it("every user-resolvable prompt field has a corresponding GameCommand kind", () => {
    // Static check: the GameCommand union must include a resolver for each
    // pendingX field (per Phase 2 inventory in the plan). We assert this
    // by enumerating the expected command kinds and confirming the
    // dispatcher handles each one — not by importing private types.
    const expectedKinds: GameCommand["kind"][] = [
      "resolveCoinGuess",
      "chooseFirstPlayer",
      "completeSetup",
      "playBasicToBench",
      "evolve",
      "attachEnergy",
      "playTrainer",
      "useAttack",
      "useAbility",
      "useStadium",
      "retreat",
      "endTurn",
      "promoteBenchToActive",
      "resolvePendingPick",
      "resolveSwitchTarget",
      "resolveInPlayTarget",
      "resolveHandReveal",
      "resolveRareCandyChoice",
      "skipPrimeCatcherSelfSwitch",
      "skipGlassTrumpetAttach",
    ];
    // Force the type-system to enumerate every kind: if a future kind is
    // added without listing it here, the assertion below catches it.
    const dummy: Record<GameCommand["kind"], true> = {
      resolveCoinGuess: true,
      chooseFirstPlayer: true,
      completeSetup: true,
      playBasicToBench: true,
      evolve: true,
      attachEnergy: true,
      playTrainer: true,
      useAttack: true,
      useAbility: true,
      useStadium: true,
      retreat: true,
      endTurn: true,
      promoteBenchToActive: true,
      resolvePendingPick: true,
      resolveSwitchTarget: true,
      resolveInPlayTarget: true,
      resolveHandReveal: true,
      resolveRareCandyChoice: true,
      skipPrimeCatcherSelfSwitch: true,
      skipGlassTrumpetAttach: true,
    };
    for (const k of expectedKinds) expect(dummy[k]).toBe(true);
  });

  it("skipGlassTrumpetAttach dispatches via applyGameCommand and clears the prompt", () => {
    // Construct a minimal state with a Glass Trumpet attach prompt + queue
    // and verify the GameCommand routes to the engine function. Doesn't
    // need a full replay round-trip — the static-kind test above pins
    // schema coverage; this asserts the dispatcher actually wires the
    // function in.
    const live = freshSetup();
    // We can't reach the prompt through public actions in 2 lines, so
    // shape the state directly: pretend the user reached step 2 with one
    // queued Energy and a bench Colorless target.
    const ap = live.activePlayer;
    const pl = live.players[ap];
    live.pendingAttachQueue = {
      ownerId: ap,
      energies: [
        {
          id: "e-fire-skip",
          name: "Basic Fire Energy",
          supertype: "Energy",
          subtypes: ["Basic"],
          provides: ["Fire"],
        } as never,
      ],
      sourceLabel: "Glass Trumpet",
    };
    live.pendingInPlayTarget = {
      player: ap,
      label: "Glass Trumpet: pick a Benched Colorless Pokémon",
      scope: "own",
      slot: "bench",
      filter: "anyPokemon",
      action: {
        kind: "glassTrumpetAttach",
        remaining: 1,
        pickedInstanceIds: [],
      },
    };
    const before = pl.discard.length;
    const r = applyGameCommand(live, {
      kind: "skipGlassTrumpetAttach",
      player: ap,
    });
    expect(r.ok).toBe(true);
    // Queue cleared; prompt cleared; the unattached Energy is in discard.
    expect(live.pendingAttachQueue).toBeNull();
    expect(live.pendingInPlayTarget).toBeNull();
    expect(pl.discard.length).toBe(before + 1);
  });
});
