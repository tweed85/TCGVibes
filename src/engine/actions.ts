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
  endTurn as endTurnRule,
  energyProvidedBy,
  isBasic,
  isPokemon,
  logEvent,
  makePokemonInPlay,
  opponentOf,
} from "./rules";

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
  target.damage = target.damage; // damage persists through evolution
  target.evolvedThisTurn = true;
  logEvent(state, player, `evolves into ${card.name}.`);
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
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card || card.supertype !== "Trainer") return fail("Not a Trainer card.");
  const t = card as TrainerCard;
  if (t.subtypes.includes("Supporter") && pl.supporterPlayedThisTurn)
    return fail("Already played a Supporter this turn.");

  pl.hand.splice(handIndex, 1);
  applyTrainerEffect(state, player, t);
  if (t.subtypes.includes("Supporter")) pl.supporterPlayedThisTurn = true;
  pl.discard.push(t);
  logEvent(state, player, `plays ${t.name}.`);
  return ok;
}

function applyTrainerEffect(state: GameState, player: PlayerId, t: TrainerCard) {
  const pl = state.players[player];
  switch (t.effectId) {
    case "drawTwo": {
      drawN(pl, 2, state, player);
      return;
    }
    case "drawUntilSix": {
      const n = Math.max(0, 6 - pl.hand.length);
      drawN(pl, n, state, player);
      return;
    }
    case "heal30Active": {
      if (pl.active) pl.active.damage = Math.max(0, pl.active.damage - 30);
      return;
    }
    default:
      // Unknown effect — no-op, but card is still discarded.
      return;
  }
}

import type { PlayerState } from "./types";

function drawN(pl: PlayerState, n: number, state: GameState, player: PlayerId) {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const c = pl.deck.shift();
    if (!c) break;
    pl.hand.push(c);
    drawn++;
  }
  logEvent(state, player, `draws ${drawn} card(s).`);
}

export function retreat(
  state: GameState,
  player: PlayerId,
  benchIndex: number,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  if (!pl.active) return fail("No Active Pokémon.");
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
  pl.active = newActive;
  pl.bench.push(oldActive);
  logEvent(state, player, `retreats ${oldActive.card.name}; ${newActive.card.name} is now Active.`);
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
  const move = atk.card.attacks[attackIndex];
  if (!move) return fail("No such attack.");
  const provided = energyProvidedBy(atk);
  if (!canPayCost(provided, move.cost))
    return fail("Not enough Energy for that attack.");

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
  logEvent(state, player, `attacks with ${move.name} for ${damage}.`);
  if (damage > 0) applyDamage(state, defOwner, damage);
  // applyDamage may set phase to gameOver (KO + win). Only end turn if game still live.
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
