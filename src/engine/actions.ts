import type {
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";
import {
  applyDamage,
  canPayCost,
  clearAllStatuses,
  endTurn as endTurnRule,
  energyProvidedBy,
  flipCoin,
  hasStatus,
  isBasic,
  isPokemon,
  knockOut,
  logEvent,
  makePokemonInPlay,
  opponentOf,
  passTurn,
  resolveBenchKOs,
} from "./rules";
import { resolveAttackEffects } from "./effects";

export type ActionResult =
  | { ok: true }
  | { ok: false; reason: string };

const ok: ActionResult = { ok: true };
const fail = (reason: string): ActionResult => ({ ok: false, reason });

const BENCH_MAX = 5;

// Guard: is it this player's main phase?
function requireMain(state: GameState, player: PlayerId): ActionResult {
  if (state.phase === "gameOver") return fail("Game is over.");
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Not in main phase.");
  return ok;
}

export function playBasicToBench(
  state: GameState,
  player: PlayerId,
  handIndex: number,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card) return fail("No such card in hand.");
  if (!isPokemon(card) || !isBasic(card)) return fail("Must be a Basic Pokémon.");
  if (pl.bench.length >= BENCH_MAX) return fail("Bench is full.");
  pl.hand.splice(handIndex, 1);
  pl.bench.push(makePokemonInPlay(card));
  logEvent(state, player, `plays ${card.name} to the Bench.`);
  return ok;
}

function findInPlayByInstance(
  state: GameState,
  player: PlayerId,
  instanceId: string,
): PokemonInPlay | null {
  const pl = state.players[player];
  if (pl.active?.instanceId === instanceId) return pl.active;
  return pl.bench.find((p) => p.instanceId === instanceId) ?? null;
}

export function evolve(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  targetInstanceId: string,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card || !isPokemon(card)) return fail("Must evolve with a Pokémon card.");
  if (!card.evolvesFrom) return fail("That card is not an evolution.");
  const target = findInPlayByInstance(state, player, targetInstanceId);
  if (!target) return fail("Target not in play.");
  if (target.card.name !== card.evolvesFrom)
    return fail(`${card.name} evolves from ${card.evolvesFrom}, not ${target.card.name}.`);
  if (target.playedThisTurn) return fail("Can't evolve a Pokémon played this turn.");
  if (target.evolvedThisTurn) return fail("Already evolved this turn.");
  if (state.turn === 1) return fail("No evolving on the first turn.");

  pl.hand.splice(handIndex, 1);
  target.evolvedFrom.push(target.card);
  target.card = card;
  // damage persists; all Special Conditions are removed on evolution.
  clearAllStatuses(target);
  // Tools carry over; abilities reset.
  target.abilityUsedThisTurn = false;
  target.evolvedThisTurn = true;
  logEvent(state, player, `evolves into ${card.name}.`);

  // Mega Evolution rule: evolving into a Mega Pokémon ends your turn.
  // Detected via the "Mega Evolution rule" text on the card's rule box.
  const rules = card.rules ?? [];
  const isMega =
    card.subtypes.some((s) => /^Mega/i.test(s)) ||
    rules.some((r) => /when .* Mega Evolves, your turn ends/i.test(r)) ||
    rules.some((r) => /Mega Evolution rule/i.test(r));
  if (isMega) {
    logEvent(state, "system", `${card.name}'s Mega Evolution ends the turn.`);
    endTurnRule(state);
  }
  return ok;
}

export function attachEnergy(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  targetInstanceId: string,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  if (pl.energyAttachedThisTurn) return fail("Already attached an Energy this turn.");
  const card = pl.hand[handIndex];
  if (!card || card.supertype !== "Energy")
    return fail("Must select an Energy card.");
  const target = findInPlayByInstance(state, player, targetInstanceId);
  if (!target) return fail("Target not in play.");
  pl.hand.splice(handIndex, 1);
  target.attachedEnergy.push(card as EnergyCard);
  pl.energyAttachedThisTurn = true;
  logEvent(state, player, `attaches ${card.name} to ${target.card.name}.`);
  return ok;
}

export function playTrainer(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  target?: TrainerTarget,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card || card.supertype !== "Trainer") return fail("Not a Trainer card.");
  const t = card as TrainerCard;
  const isSupporter = t.subtypes.includes("Supporter");
  const isStadium = t.subtypes.includes("Stadium");
  const isTool = t.subtypes.includes("Pokémon Tool") || t.subtypes.includes("Tool");

  if (isSupporter) {
    if (pl.supporterPlayedThisTurn)
      return fail("Already played a Supporter this turn.");
    // Current rule: first player cannot play a Supporter on their first turn.
    if (state.firstTurnNoAttack && state.activePlayer === "p1" && state.turn === 1)
      return fail("First player can't play a Supporter on the first turn.");
  }

  // Tool: must be attached to a Pokémon in play with no Tool already.
  if (isTool) {
    const targetId = target?.kind === "inPlay" ? target.instanceId : null;
    if (!targetId) return fail("Pick a Pokémon to attach this Tool to.");
    const p = findInPlayByInstance(state, player, targetId);
    if (!p) return fail("Target not in play.");
    if ((p.tools?.length ?? 0) >= 1)
      return fail("That Pokémon already has a Tool attached.");
    pl.hand.splice(handIndex, 1);
    p.tools.push(t);
    logEvent(state, player, `attaches ${t.name} to ${p.card.name}.`);
    return ok;
  }

  // Stadium: replaces any existing Stadium (discards it, including the
  // opponent's if they had one). The new Stadium is now controlled by
  // whoever played it.
  if (isStadium) {
    if (state.stadium) {
      const prev = state.stadium;
      state.players[prev.controller].discard.push(prev.card);
      logEvent(state, "system", `${prev.card.name} is replaced and discarded.`);
    }
    pl.hand.splice(handIndex, 1);
    state.stadium = { card: t, controller: player };
    logEvent(state, player, `plays Stadium ${t.name}.`);
    return ok;
  }

  // Item / Supporter: discard after effect applies.
  pl.hand.splice(handIndex, 1);
  applyTrainerEffect(state, player, t, target);
  if (isSupporter) pl.supporterPlayedThisTurn = true;
  pl.discard.push(t);
  logEvent(state, player, `plays ${t.name}.`);
  return ok;
}

// Target descriptor for trainer effects that need a target.
export type TrainerTarget =
  | { kind: "inPlay"; instanceId: string }
  | { kind: "oppInPlay"; instanceId: string }
  | { kind: "handCard"; handIndex: number }
  | { kind: "discardCard"; discardIndex: number };

import { applyTrainerEffect } from "./trainerEffects";

export function retreat(
  state: GameState,
  player: PlayerId,
  benchIndex: number,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  if (pl.retreatedThisTurn) return fail("Already retreated this turn.");
  if (!pl.active) return fail("No Active Pokémon.");
  if (hasStatus(pl.active, "asleep")) return fail("Asleep Pokémon can't retreat.");
  if (hasStatus(pl.active, "paralyzed")) return fail("Paralyzed Pokémon can't retreat.");
  if (benchIndex < 0 || benchIndex >= pl.bench.length)
    return fail("Invalid bench slot.");
  const cost = pl.active.card.retreatCost ?? [];
  const provided = energyProvidedBy(pl.active);
  if (!canPayCost(provided, cost))
    return fail("Not enough Energy to retreat.");
  // Pay by discarding Colorless cost — discard the first N attached energies.
  for (let i = 0; i < cost.length; i++) {
    const e = pl.active.attachedEnergy.shift();
    if (e) pl.discard.push(e);
  }
  const [newActive] = pl.bench.splice(benchIndex, 1);
  const oldActive = pl.active;
  // Retreating clears all Special Conditions from the retreating Pokémon.
  clearAllStatuses(oldActive);
  pl.active = newActive;
  pl.bench.push(oldActive);
  pl.retreatedThisTurn = true;
  logEvent(state, player, `retreats ${oldActive.card.name}; ${newActive.card.name} is now Active.`);
  return ok;
}

// User-facing action when the game is paused on pendingPromote. Dispatches
// to the continuation queued by the code that triggered the promote:
//   - "endTurn" (default): run end-of-turn cleanup + pass to opponent
//   - "passTurn": skip cleanup (already happened) and pass
//   - null: do nothing more (promote happened mid-main-phase, rare)
export function promoteBenchToActive(
  state: GameState,
  player: PlayerId,
  benchIndex: number,
): ActionResult {
  if (state.pendingPromote !== player)
    return fail("Not waiting for your promote.");
  const pl = state.players[player];
  if (benchIndex < 0 || benchIndex >= pl.bench.length)
    return fail("Invalid bench slot.");
  const [promoted] = pl.bench.splice(benchIndex, 1);
  promoted.playedThisTurn = false;
  pl.active = promoted;
  state.pendingPromote = null;
  state.phase = "main";
  logEvent(state, player, `promotes ${promoted.card.name} to Active.`);

  const cont = state.onPromoteResolved;
  state.onPromoteResolved = null;
  if (cont === "endTurn") endTurnRule(state);
  else if (cont === "passTurn") passTurn(state);
  return ok;
}

export function attack(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): ActionResult {
  if (state.phase === "gameOver") return fail("Game is over.");
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Not in main phase.");
  if (state.firstTurnNoAttack) return fail("No attacking on the first turn.");
  const pl = state.players[player];
  const atk = pl.active;
  if (!atk) return fail("No Active Pokémon.");
  if (hasStatus(atk, "asleep")) return fail("Asleep Pokémon can't attack.");
  if (hasStatus(atk, "paralyzed")) return fail("Paralyzed Pokémon can't attack.");
  const move = atk.card.attacks[attackIndex];
  if (!move) return fail("No such attack.");
  const provided = energyProvidedBy(atk);
  if (!canPayCost(provided, move.cost))
    return fail("Not enough Energy for that attack.");

  // Confusion: flip on attack; on tails, attack fails and 30 damage to self.
  if (hasStatus(atk, "confused")) {
    const heads = flipCoin(state, `${atk.card.name} confusion flip`);
    if (!heads) {
      atk.damage += 30;
      logEvent(state, "system", `${atk.card.name} hurts itself in confusion (30 damage).`);
      if (atk.damage >= atk.card.hp) knockOut(state, player);
      if (state.pendingPromote) {
        state.onPromoteResolved = "endTurn";
        return ok;
      }
      const phase2: string = state.phase;
      if (phase2 !== "gameOver") endTurnRule(state);
      return ok;
    }
  }

  const defOwner = opponentOf(player);
  const def = state.players[defOwner].active;
  let damage = move.damage;
  if (def) {
    const atkType = atk.card.types[0];
    const weak = def.card.weaknesses?.find((w) => w.type === atkType);
    const res = def.card.resistances?.find((w) => w.type === atkType);
    if (weak && weak.value.startsWith("×")) {
      damage *= parseInt(weak.value.slice(1), 10) || 2;
    }
    if (res && res.value.startsWith("-")) {
      damage = Math.max(0, damage - (parseInt(res.value.slice(1), 10) || 30));
    }
  }

  // Resolve structured attack effects (coin flips, per-energy bonuses, bench
  // snipes, status infliction, etc.). Effects can modify `damage` and/or
  // trigger their own side-effects; `aborted` means the attack did nothing.
  const result = resolveAttackEffects(state, {
    attacker: atk,
    attackerOwner: player,
    defender: def,
    defenderOwner: defOwner,
    move,
    damage,
  });
  damage = result.damage;

  logEvent(state, player, `attacks with ${move.name} for ${damage}.`);
  if (damage > 0) applyDamage(state, defOwner, damage);
  // Post-damage effects (self-damage, status applications, bench snipe) run
  // after the main hit so e.g. KOs land before side effects apply.
  if ((state.phase as string) !== "gameOver") {
    result.postDamage?.();
  }
  // Bench snipes / recoil / confusion damage can KO benched Pokémon — resolve
  // those now so opponents get prizes for them before the turn ends.
  if ((state.phase as string) !== "gameOver") {
    resolveBenchKOs(state);
  }
  // Self-KO from recoil / confusion — trigger the KO flow explicitly.
  if ((state.phase as string) !== "gameOver" && pl.active && pl.active.damage >= pl.active.card.hp) {
    knockOut(state, player);
  }
  // If an active was KO'd, we're now paused on pendingPromote — queue
  // end-of-turn to run once the promote resolves.
  if (state.pendingPromote) {
    state.onPromoteResolved = "endTurn";
    return ok;
  }
  const phaseAfter: string = state.phase;
  if (phaseAfter !== "gameOver") endTurnRule(state);
  return ok;
}

export function endTurn(state: GameState, player: PlayerId): ActionResult {
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Can't end turn now.");
  endTurnRule(state);
  return ok;
}

// Re-export commonly used helpers for consumers.
export { isBasic, isPokemon } from "./rules";
export type { Card, PokemonCard, EnergyCard, TrainerCard, EnergyType, PokemonInPlay };
