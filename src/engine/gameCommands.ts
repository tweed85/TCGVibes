// GameCommand — the structured input layer for replay. Each command is a
// thin wrapper around a single existing engine action. Recording commands
// in addition to (not instead of) calling the actions means the engine
// stays the source of truth and replay is just "apply this sequence
// against an initial state with a fixed RNG seed".
//
// Determinism contract: replay reproduces the original game ONLY against
// the same engine code path and the same card dataset. The replay header
// in `replay.ts` carries `appVersion` and `dataVersion` so a stale replay
// is recognizably stale rather than silently wrong.

import {
  attachEnergy,
  attack,
  evolve,
  playBasicToBench,
  playTrainer,
  promoteBenchToActive,
  retreat,
  type ActionResult,
  type TrainerTarget,
} from "./actions";
import { activateAbility } from "./abilities";
import { resolvePendingPick } from "./pendingPick";
import {
  resolveSwitchTarget,
  resolveInPlayTarget,
  resolveHandReveal,
  resolveRareCandyChoice,
  skipPrimeCatcherSelfSwitch,
} from "./trainerEffects";
import { useStadium } from "./stadiumActivated";
import { endTurn } from "./actions";
import {
  chooseFirstPlayer,
  completeSetup,
  resolveCoinGuess,
} from "./rules";
import type { GameState, PlayerId } from "./types";

// Each user-resolvable prompt field maps to a command kind below — the
// contract test in __tests__/replay.test.ts pins this, so adding a new
// pending field without a corresponding command will fail loudly.
export type GameCommand =
  // Pre-game setup decisions. Without these, replays starting from
  // setupGame() never leave phase="coinFlip" — every later command would
  // desync because the engine isn't in main.
  | { kind: "resolveCoinGuess"; player: PlayerId; guess: "heads" | "tails" }
  | { kind: "chooseFirstPlayer"; player: PlayerId; chooseFirst: boolean }
  | {
      kind: "completeSetup";
      player: PlayerId;
      activeHandIndex: number;
      benchHandIndexes: number[];
    }
  // Hand actions
  | { kind: "playBasicToBench"; player: PlayerId; handIndex: number }
  | { kind: "evolve"; player: PlayerId; handIndex: number; targetInstanceId: string }
  | { kind: "attachEnergy"; player: PlayerId; handIndex: number; targetInstanceId: string }
  | { kind: "playTrainer"; player: PlayerId; handIndex: number; target?: TrainerTarget }
  // Active-side actions
  | { kind: "useAttack"; player: PlayerId; attackIndex: number }
  | { kind: "useAbility"; player: PlayerId; instanceId: string; abilityIndex: number }
  | { kind: "useStadium"; player: PlayerId }
  | { kind: "retreat"; player: PlayerId; benchIndex: number }
  | { kind: "endTurn"; player: PlayerId }
  // Promote (post-KO + Switch flows)
  | { kind: "promoteBenchToActive"; player: PlayerId; benchIndex: number }
  // Pending-prompt resolutions — one per user-resolvable prompt field.
  | { kind: "resolvePendingPick"; player: PlayerId; pickedIndexes: number[] }
  | { kind: "resolveSwitchTarget"; player: PlayerId; benchIndex: number }
  | { kind: "resolveInPlayTarget"; player: PlayerId; targetOwner: PlayerId; instanceId: string }
  | { kind: "resolveHandReveal"; player: PlayerId; pickedHandIndexes: number[] }
  | { kind: "resolveRareCandyChoice"; player: PlayerId; handIndex: number }
  // Optional-prompt skip — Prime Catcher's "If you do, you may switch your
  // Active." Without an explicit skip command, exported replays would stall
  // on the optional prompt.
  | { kind: "skipPrimeCatcherSelfSwitch"; player: PlayerId };

/**
 * Apply a command to the live game state. Thin dispatcher over the
 * existing action surface — every command kind ends up calling the same
 * function the UI calls.
 *
 * Returns the engine's `ActionResult` so the recorder can decide whether
 * to keep the command in the stream (only `ok: true` commands are
 * recorded; failed actions never appear in the replay).
 */
export function applyGameCommand(state: GameState, c: GameCommand): ActionResult {
  switch (c.kind) {
    case "resolveCoinGuess": {
      // resolveCoinGuess returns void; treat "phase moved off coinFlip-pickGuess
      // step" as success. Failure cases (wrong phase, already resolved) leave
      // state.coinFlip.step unchanged.
      const before = state.coinFlip?.step;
      resolveCoinGuess(state, c.guess);
      const after = state.coinFlip?.step;
      if (before === "pickGuess" && after !== "pickGuess") return { ok: true };
      return { ok: false, reason: "Coin guess not accepted (wrong phase or already resolved)." };
    }
    case "chooseFirstPlayer": {
      const err = chooseFirstPlayer(state, c.player, c.chooseFirst);
      if (err) return { ok: false, reason: err };
      // Successful chooseFirstPlayer transitions phase to "setup".
      return { ok: true };
    }
    case "completeSetup": {
      const err = completeSetup(state, c.player, c.activeHandIndex, c.benchHandIndexes);
      if (err) return { ok: false, reason: err };
      // Once both players complete setup, completeSetup sets phase="main".
      return { ok: true };
    }
    case "playBasicToBench":
      return playBasicToBench(state, c.player, c.handIndex);
    case "evolve":
      return evolve(state, c.player, c.handIndex, c.targetInstanceId);
    case "attachEnergy":
      return attachEnergy(state, c.player, c.handIndex, c.targetInstanceId);
    case "playTrainer":
      return playTrainer(state, c.player, c.handIndex, c.target);
    case "useAttack":
      return attack(state, c.player, c.attackIndex);
    case "useAbility": {
      const r = activateAbility(state, c.player, c.instanceId, c.abilityIndex);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Ability failed." };
    }
    case "useStadium": {
      const r = useStadium(state, c.player);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    }
    case "retreat":
      return retreat(state, c.player, c.benchIndex);
    case "endTurn":
      return endTurn(state, c.player);
    case "promoteBenchToActive":
      return promoteBenchToActive(state, c.player, c.benchIndex);
    case "resolvePendingPick":
      return resolvePendingPick(state, c.player, c.pickedIndexes);
    case "resolveSwitchTarget": {
      const r = resolveSwitchTarget(state, c.player, c.benchIndex);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Switch failed." };
    }
    case "resolveInPlayTarget": {
      const r = resolveInPlayTarget(state, c.player, c.targetOwner, c.instanceId);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Target failed." };
    }
    case "resolveHandReveal": {
      const r = resolveHandReveal(state, c.player, c.pickedHandIndexes);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Hand reveal failed." };
    }
    case "resolveRareCandyChoice": {
      const r = resolveRareCandyChoice(state, c.player, c.handIndex);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Rare Candy failed." };
    }
    case "skipPrimeCatcherSelfSwitch": {
      const r = skipPrimeCatcherSelfSwitch(state, c.player);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Skip failed." };
    }
  }
}
